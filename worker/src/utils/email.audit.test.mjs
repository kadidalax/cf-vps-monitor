import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const config = {
  host: 'smtp.example.test', port: 587, security: 'starttls', authMethod: 'plain',
  username: 'synthetic-user', password: 'synthetic-password', fromAddress: 'from@example.test',
  fromName: 'fixture', recipients: ['to@example.test'],
};

// A byte-stream SMTP peer. No sockets, subprocesses or external traffic exist.
function smtpPeer({ security = 'starttls', split = 'coalesced', multiline = false, reject = '', upgradeFails = false, quitHangs = false } = {}) {
  const commands = [];
  const events = [];
  let encrypted = security === 'tls';
  let inBody = false;
  let loginStage = 0;
  function makeSocket(greeting) {
    let controller;
    let closed = false;
    function reply(lines) {
      const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
      if (split === 'byte') {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      } else if (split === 'lines') {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(line + '\r\n'));
      } else controller.enqueue(bytes);
    }
    const socket = {
      opened: Promise.resolve({}),
      readable: new ReadableStream({ start(value) { controller = value; if (greeting) reply(['220 fixture ready']); } }),
      writable: new WritableStream({
        write(bytes) {
          if (closed) throw new Error('Used the old socket after STARTTLS');
          const text = new TextDecoder().decode(bytes).trimEnd();
          commands.push({ text, encrypted });
          if (inBody) { inBody = false; reply([reject === 'body' ? '554 content refused' : '250 accepted']); return; }
          if (loginStage === 1) { loginStage = 2; reply([reject === 'login-user' ? '535 username rejected' : '334 Password']); return; }
          if (loginStage === 2) { loginStage = 0; reply([reject === 'login-password' ? '535 password rejected' : '235 authenticated']); return; }
          if (text.startsWith('EHLO ')) {
            if (multiline) reply([
              '250-fixture', '250-PIPELINING', '250-SIZE 100000', '250-8BITMIME',
              '250-ENHANCEDSTATUSCODES', '250-STARTTLS', '250 AUTH PLAIN LOGIN',
            ]);
            else reply([encrypted ? '250 AUTH PLAIN LOGIN' : '250 STARTTLS']);
          } else if (text === 'STARTTLS') {
            events.push('STARTTLS');
            reply([reject === 'starttls' ? '454 TLS unavailable' : '220 begin TLS']);
          } else if (text === 'AUTH LOGIN') { loginStage = 1; reply([reject === 'login-initial' ? '535 method rejected' : '334 Username']); }
          else if (text.startsWith('AUTH ')) reply([reject === 'auth' ? '535 credentials rejected' : '235 authenticated']);
          else if (text.startsWith('MAIL FROM:')) reply(['250 sender accepted']);
          else if (text.startsWith('RCPT TO:')) reply([reject === 'recipient' ? '550 recipient rejected' : '250 recipient accepted']);
          else if (text === 'DATA') {
            inBody = reject !== 'data';
            reply([reject === 'data' ? '250 wrong phase' : '354 send content']);
          } else if (text === 'QUIT') {
            if (quitHangs) return new Promise(() => {});
            reply(['221 bye']);
          }
          else reply(['500 unsupported command']);
        },
      }),
      startTls() {
        events.push('socket.startTls');
        if (upgradeFails) throw new Error('Synthetic TLS handshake failure');
        assert.equal(socket.readable.locked, false, 'release old reader before upgrading');
        assert.equal(socket.writable.locked, false, 'release old writer before upgrading');
        closed = true;
        controller.close();
        encrypted = true;
        return makeSocket(false);
      },
      close() { if (!closed) { closed = true; controller.close(); } return Promise.resolve(); },
    };
    return socket;
  }
  const loader = createWorkerLoader({ overrides: {
    'cloudflare:sockets': { connect: (_address, options) => {
      assert.equal(options.secureTransport, security === 'tls' ? 'on' : 'starttls');
      return makeSocket(true);
    } },
  } });
  return { commands, events, send: loader.load('worker/src/utils/email.ts').sendSmtpEmail };
}

test('AUD-04: STARTTLS upgrades the actual transport and repeats EHLO before credentials', async () => {
  const peer = smtpPeer();
  const result = await peer.send(config, 'synthetic subject', 'synthetic message');
  assert.equal(result.ok, true);
  assert.deepEqual(peer.events, ['STARTTLS', 'socket.startTls']);
  assert.equal(peer.commands.filter(command => command.text.startsWith('EHLO ')).length, 2);
  assert.ok(peer.commands.filter(command => command.text.startsWith('AUTH ')).every(command => command.encrypted));
});

test('AUD-04: refused STARTTLS and handshake errors never fall back to plaintext authentication', async () => {
  for (const options of [{ reject: 'starttls' }, { upgradeFails: true }]) {
    const peer = smtpPeer(options);
    const result = await peer.send(config, 'subject', 'body');
    assert.equal(result.ok, false);
    assert.equal(peer.commands.filter(command => command.text.startsWith('AUTH ')).length, 0);
  }
});

test('AUD-11: multiline and arbitrarily split replies yield the same successful transaction', async () => {
  for (const split of ['coalesced', 'lines', 'byte']) {
    const peer = smtpPeer({ security: 'tls', split, multiline: true });
    assert.equal((await peer.send({ ...config, security: 'tls' }, 'subject', 'body')).ok, true, split);
    assert.ok(peer.commands.some(command => command.text === 'DATA'));
  }
});

test('AUD-11: AUTH, RCPT, DATA phase and content rejection cannot report delivery success', async () => {
  for (const reject of ['auth', 'recipient', 'data', 'body']) {
    for (const split of ['coalesced', 'lines', 'byte']) {
      const peer = smtpPeer({ security: 'tls', split, multiline: true, reject });
      const result = await peer.send({ ...config, security: 'tls' }, 'subject', 'body');
      assert.equal(result.ok, false, `${reject}, ${split}: server did not accept the message`);
    }
  }
});

test('AUD-11: accepted mail stays successful when QUIT cannot complete', async () => {
  const peer = smtpPeer({ security: 'tls', quitHangs: true });
  const result = await peer.send({ ...config, security: 'tls' }, 'subject', 'body');
  assert.equal(result.ok, true, 'The server already accepted DATA with 250; QUIT is not a delivery transaction');
});

test('AUD-11: LOGIN works over both TLS modes and stops on a rejected credential challenge', async () => {
  for (const security of ['tls', 'starttls']) {
    const peer = smtpPeer({ security, multiline: true, split: 'byte' });
    assert.equal((await peer.send({ ...config, security, authMethod: 'login' }, 'subject', 'body')).ok, true);
  }
  for (const reject of ['login-initial', 'login-user', 'login-password']) {
    const peer = smtpPeer({ security: 'tls', reject });
    assert.equal((await peer.send({ ...config, security: 'tls', authMethod: 'login' }, 'subject', 'body')).ok, false);
    if (reject !== 'login-password') assert.ok(!peer.commands.some(command => command.text === Buffer.from(config.password).toString('base64')));
  }
});
