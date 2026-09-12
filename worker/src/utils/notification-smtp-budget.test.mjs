import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const settings = {
  notification_method: 'email', email_smtp_host: 'smtp.synthetic.test', email_smtp_port: '465',
  email_smtp_security: 'tls', email_smtp_auth_method: 'plain',
  email_smtp_username: 'synthetic-user', email_smtp_password: 'synthetic-password',
  email_smtp_from_address: 'from@example.test', email_smtp_recipients: 'to@example.test',
};

async function deliveryFixture({ elapsed = 54000, silent = true, requestsUsed = 0 } = {}) {
  let now = 0;
  let timerId = 0;
  let sockets = 0;
  let closes = 0;
  let settled = false;
  let cursorSaved = false;
  const timers = new Map();
  const completions = [];
  const health = [];
  const commands = [];
  const loader = createWorkerLoader({
    globals: {
      setTimeout: (callback, duration) => {
        const id = ++timerId;
        timers.set(id, { callback, at: now + duration });
        return id;
      },
      clearTimeout: id => timers.delete(id),
    },
    overrides: {
      'cloudflare:sockets': {
        connect() {
          sockets += 1;
          let controller;
          let closed = false;
          let inBody = false;
          const reply = text => controller.enqueue(new TextEncoder().encode(`${text}\r\n`));
          return {
            opened: Promise.resolve({}),
            readable: new ReadableStream({ start(value) { controller = value; if (!silent) reply('220 synthetic ready'); } }),
            writable: new WritableStream({ write(bytes) {
              const command = new TextDecoder().decode(bytes).trimEnd();
              commands.push(command);
              if (silent) return;
              if (inBody) { inBody = false; reply('250 accepted'); }
              else if (command.startsWith('EHLO ')) reply('250 AUTH PLAIN');
              else if (command.startsWith('AUTH ')) reply('235 authenticated');
              else if (command.startsWith('MAIL FROM:') || command.startsWith('RCPT TO:')) reply('250 accepted');
              else if (command === 'DATA') { inBody = true; reply('354 send content'); }
              else if (command === 'QUIT') reply('221 bye');
            } }),
            close() { if (!closed) { closed = true; closes += 1; controller.close(); } return Promise.resolve(); },
          };
        },
      },
    },
  });
  const { ScheduledBudget, ScheduledBudgetExceeded, withScheduledBudget } = loader.load('worker/src/utils/scheduled-budget.ts');
  const { deliverNotification, dispatchNotification } = loader.load('worker/src/utils/notification-dispatch.ts');
  const budget = new ScheduledBudget({ now: () => now, maxDurationMs: 60000, reserveMs: 5000 });
  if (requestsUsed) budget.consume(requestsUsed);
  now = elapsed;
  const operation = withScheduledBudget(budget, async () => {
    try {
      return await deliverNotification({
        claim: async () => ({ claimed: true, delivered: false, token: 'synthetic-lease' }),
        complete: async (_token, success) => { completions.push(success); budget.consume(); return true; },
        send: () => dispatchNotification({}, settings, { subject: 'synthetic', body: 'synthetic' }, {
          deps: { recordHealth: async (_db, _component, status) => { health.push(status); budget.consume(); } },
        }),
      });
    } finally {
      await budget.complete(async () => { budget.consume(); cursorSaved = true; });
    }
  }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  // Only advance a controlled timer after the actual promise/stream operations
  // had a chance to settle. A silent peer therefore exercises the real timeout.
  for (let step = 0; step < 100 && !settled; step += 1) {
    await new Promise(setImmediate);
    if (settled) break;
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (next) {
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
    }
  }
  assert.equal(settled, true, 'the actual delivery must finish within a bounded timer schedule');
  return { ...await operation, now, sockets, closes, completions, health, commands, cursorSaved, ScheduledBudgetExceeded };
}

test('AUD-14 SMTP budget expiry defers delivery before the five-second completion reserve', async () => {
  const result = await deliveryFixture();
  assert.ok(result.now <= 55000, `SMTP consumed the completion reserve and reached ${result.now}ms`);
  assert.ok(result.error instanceof result.ScheduledBudgetExceeded, 'budget expiry is deferred work');
  assert.deepEqual(result.completions, [], 'deferred work must not consume delivery success/failure state');
  assert.deepEqual(result.health, [], 'budget expiry is not a provider failure');
  assert.equal(result.cursorSaved, true);
  assert.equal(result.sockets, 1);
  assert.equal(result.closes, 1);
  assert.deepEqual(result.commands, [], 'a silent greeting cannot reach authentication or message delivery');
});

test('AUD-14 SMTP cannot spend requests reserved for completing the scheduled invocation', async () => {
  const result = await deliveryFixture({ elapsed: 1000, requestsUsed: 39 });
  assert.ok(result.error instanceof result.ScheduledBudgetExceeded);
  assert.equal(result.sockets, 0, 'two SMTP connection requests cannot use the four reserved tail requests');
  assert.deepEqual(result.completions, []);
  assert.deepEqual(result.health, []);
  assert.equal(result.cursorSaved, true);
});

test('AUD-14 an ordinary SMTP timeout remains a retryable delivery failure with ample invocation budget', async () => {
  const result = await deliveryFixture({ elapsed: 0 });
  assert.equal(result.now, 8000);
  assert.equal(result.error, undefined);
  assert.equal(result.value, false);
  assert.deepEqual(result.completions, [false]);
  assert.deepEqual(result.health, ['error']);
  assert.equal(result.cursorSaved, true);
});

test('AUD-14 accepted SMTP delivery still records success near the scheduled deadline', async () => {
  const result = await deliveryFixture({ silent: false });
  assert.equal(result.error, undefined);
  assert.equal(result.value, true);
  assert.deepEqual(result.completions, [true]);
  assert.deepEqual(result.health, ['ok']);
  assert.equal(result.cursorSaved, true);
  assert.ok(result.commands.includes('DATA'));
});
