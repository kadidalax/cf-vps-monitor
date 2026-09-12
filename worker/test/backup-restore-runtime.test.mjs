import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { generateToken } from '../src/auth/jwt.ts';
import { generateMfaToken } from '../src/auth/mfa-token.ts';
import { encryptBackup } from '../src/utils/backup.ts';
import { hashAgentToken } from '../src/utils/client.ts';
import { createRuntimeFixture, eventually, runtimeSecrets } from '../test-support/runtime-fixture.mjs';
import { rpc } from '../../scripts/test-support/postgres.mjs';

// A real local WebSocket peer. Observe the RFC6455 close control frame directly
// and send the required masked reply, independently of a proxy's TCP close event.
function openLocalWebSocket(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const upgrade = request(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...extraHeaders } });
    upgrade.on('error', reject);
    upgrade.on('response', response => { response.resume(); reject(new Error(`WebSocket upgrade returned ${response.statusCode}`)); });
    upgrade.on('upgrade', (response, socket, head) => {
      try {
        assert.equal(response.statusCode, 101);
        assert.equal(response.headers['sec-websocket-accept'], createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
      } catch (error) { socket.destroy(); reject(error); return; }
      let buffered = Buffer.alloc(0);
      const peer = { messages: [], closeFrame: null, closeAcknowledged: false, ended: false, error: null,
        close() { if (!socket.destroyed && !socket.writableEnded) socket.end(frame(8, Buffer.from([3, 232]))); } };
      function frame(opcode, payload) {
        assert.ok(payload.length < 126, 'fixture sends only bounded control frames');
        const mask = randomBytes(4);
        const encoded = Buffer.from(payload);
        for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= mask[index % 4];
        return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, encoded]);
      }
      socket.on('error', error => { peer.error = error; });
      socket.on('close', () => { peer.ended = true; });
      const consume = chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        try {
          while (buffered.length >= 2) {
            const opcode = buffered[0] & 0x0f;
            assert.equal(buffered[1] & 0x80, 0, 'server frames are not masked');
            let length = buffered[1] & 0x7f;
            let offset = 2;
            if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
            else if (length === 127) {
              if (buffered.length < 10) return;
              const wide = buffered.readBigUInt64BE(2);
              assert.ok(wide <= 1024n * 1024n, 'bounded fixture frame');
              length = Number(wide); offset = 10;
            }
            if (buffered.length < offset + length) return;
            const payload = buffered.subarray(offset, offset + length);
            buffered = buffered.subarray(offset + length);
            if (opcode === 1) peer.messages.push(JSON.parse(payload.toString('utf8')));
            else if (opcode === 9) socket.write(frame(10, payload));
            else if (opcode === 8) {
              peer.closeFrame = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
                reason: payload.length > 2 ? payload.subarray(2).toString('utf8') : '' };
              socket.end(frame(8, payload), () => { peer.closeAcknowledged = true; });
              return;
            }
          }
        } catch (error) { peer.error = error; socket.destroy(); }
      };
      socket.on('data', consume);
      if (head.length) consume(head);
      resolve(peer);
    });
    upgrade.end();
  });
}

test('AUD-06 native backup restoration synchronizes SQL, durable metadata and Agent authorization', { timeout: 180000 }, async t => {
  const f = await createRuntimeFixture({ persistDurableObjects: true });
  t.after(() => f.close());
  await rpc(f.database, 'cfm_create_initial_admin', {
    p_uuid: 'restore-admin', p_username: 'restore-admin', p_password_hash: 'synthetic-unused-password-hash',
  });
  const user = (await f.database.query('select uuid, username, session_version from users')).rows[0];
  const identity = { userId: user.uuid, username: user.username, sessionVersion: user.session_version };
  const session = await generateToken(user.uuid, user.username, user.session_version, runtimeSecrets);
  const stepUp = await generateMfaToken({ ...identity, purpose: 'mfa-step-up' }, runtimeSecrets);
  const csrf = 'a'.repeat(32);
  const headers = {
    'Content-Type': 'application/json', Origin: 'https://panel.example.test', 'CF-Connecting-IP': '1.1.1.1',
    Cookie: `cf_monitor_session=${session}; cf_monitor_csrf=${csrf}; cf_monitor_mfa_stepup=${stepUp}`, 'X-CSRF-Token': csrf,
  };
  const oldToken = 'native-old-agent-token-000000000000000001';
  const newToken = 'native-new-agent-token-000000000000000002';
  const oldHash = await hashAgentToken(oldToken);
  const newHash = await hashAgentToken(newToken);
  await f.database.query("insert into clients(uuid,name,token_hash) values ('old-node','Old node',$1)", [oldHash]);
  await rpc(f.database, 'cfm_set_settings', { input_settings: { record_enabled: 'false' } });
  const namespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
  const stub = namespace.get(namespace.idFromName('global'));
  assert.equal((await stub.fetch('https://do/admin-clients-snapshot', { method: 'PUT', body: JSON.stringify({
    clients: [{ uuid: 'old-node', name: 'Old node', hidden: false }],
  }) })).status, 200);
  const report = (token, cpu) => f.fetch('/api/clients/report', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
    body: JSON.stringify({ cpu, timestamp: Date.now() }),
  });
  assert.equal((await report(oldToken, 11)).status, 200);
  await eventually(async () => (await stub.fetch('https://do/agent-auth/lookup', {
    method: 'POST', body: JSON.stringify({ token_hash: oldHash }),
  })).status === 200);
  // The old Agent is connected and idle: no report/ACK is needed to observe its
  // close frame. Both peers use the actual local HTTP upgrade entrypoints.
  const runtimeUrl = await f.mf.ready;
  const agentUrl = new URL('/api/clients/report', runtimeUrl);
  const agent = await openLocalWebSocket(agentUrl, { Authorization: `Bearer ${oldToken}` });
  t.after(() => { try { agent.close(); } catch {} });
  await eventually(() => agent.messages.some(message => message.type === 'policy'));
  const viewerTokenResponse = await fetch(new URL('/api/ws/live-token', runtimeUrl));
  assert.equal(viewerTokenResponse.status, 200);
  const viewerToken = (await viewerTokenResponse.json()).token;
  const viewerUrl = new URL('/api/ws/live', runtimeUrl);
  const viewer = await openLocalWebSocket(viewerUrl, { 'Sec-WebSocket-Protocol': `cf-monitor-viewer, ${viewerToken}` });
  t.after(() => { try { viewer.close(); } catch {} });
  await eventually(() => viewer.messages.some(message => message.type === 'snapshot'));

  async function restore(clients) {
    const encrypted = await encryptBackup({ schema: 'cf-monitor.backup', version: '2.0.0', scope: 'configuration',
      timestamp: new Date().toISOString(), clients }, 'synthetic-runtime-backup-password');
    assert.equal(encrypted.ok, true);
    const response = await f.fetch('/api/admin/upload/backup', { method: 'POST', headers, body: JSON.stringify({
      backup: encrypted.encryptedBackup, backup_password: 'synthetic-runtime-backup-password',
      confirm_restore: true, acknowledge_overwrite: true,
    }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }

  await restore([{ uuid: 'new-node', name: 'Restored node', hidden: false, token_hash: newHash }]);
  await eventually(() => agent.closeFrame !== null && agent.closeAcknowledged);
  assert.equal(agent.error, null);
  assert.equal(agent.closeFrame.code, 1008, 'the restored configuration explicitly revokes the old idle Agent connection');
  assert.equal(agent.closeFrame.reason, 'Client configuration restored');
  assert.equal(viewer.closeFrame, null, 'configuration restoration keeps existing viewers connected');
  assert.equal(viewer.error, null);
  assert.deepEqual((await f.database.query('select uuid from clients order by uuid')).rows.map(row => row.uuid), ['new-node']);
  const snapshot = await (await stub.fetch('https://do/admin-clients-snapshot')).json();
  assert.deepEqual(snapshot.clients.map(client => client.uuid), ['new-node']);
  assert.equal(snapshot.complete, true);
  assert.equal((await stub.fetch('https://do/agent-auth/lookup', {
    method: 'POST', body: JSON.stringify({ token_hash: oldHash }),
  })).status, 404);
  assert.equal((await report(oldToken, 12)).status, 401, 'the actual bearer-authenticated HTTP route rejects the old Agent');
  assert.equal((await report(newToken, 23)).status, 200);
  assert.deepEqual((await (await stub.fetch('https://do/live')).json()).online, ['new-node']);

  const rows = Array.from({ length: 1000 }, (_, index) => ({ uuid: `bulk-node-${index}`, name: `Bulk node ${index}`,
    cpu_name: 'c'.repeat(200), remark: 'r'.repeat(200) }));
  await restore(rows);
  assert.equal(viewer.closeFrame, null);
  assert.equal((await f.database.query('select count(*)::int as count from clients')).rows[0].count, 1000);
  assert.equal((await (await stub.fetch('https://do/admin-clients-snapshot')).json()).clients.length, 1000);
  await f.restart();
  const restartedNamespace = await f.mf.getDurableObjectNamespace('LIVE_DATA');
  const restarted = restartedNamespace.get(restartedNamespace.idFromName('global'));
  const persisted = await (await restarted.fetch('https://do/admin-clients-snapshot')).json();
  assert.equal(persisted.clients.length, 1000);
  assert.equal(persisted.complete, true);
  assert.deepEqual((await (await restarted.fetch('https://do/live')).json()).online, []);
  assert.equal((await restarted.fetch('https://do/agent-auth/lookup', { method: 'POST', body: JSON.stringify({ token_hash: oldHash }) })).status, 404);
});
