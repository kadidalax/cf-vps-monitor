import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runGithubCiGate } from './github-ci-gate.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const ROOT = '/synthetic/check-out';

function workflow(overrides = {}) {
  return {
    id: 100,
    run_attempt: 1,
    head_sha: SHA,
    head_repository: { full_name: 'example/monitor' },
    event: 'push',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function response(runs, status = 200) {
  return { status, json: async () => ({ total_count: runs.length, workflow_runs: runs }) };
}

function fixture({
  head = SHA,
  remote = 'https://github.com/example/monitor.git',
  dirty = false,
  env = {},
  replies = [response([workflow()])],
  gitFailure,
  ...settings
} = {}) {
  let elapsed = 0;
  let headReads = 0;
  let cleanChecks = 0;
  const calls = { git: [], http: [], sleeps: [], logs: [] };
  const options = {
    root: ROOT,
    env,
    run: (command, args, options) => {
      assert.equal(command, 'git', 'the CI gate must not run builds, tests, or deployment tools');
      assert.equal(options.cwd, ROOT, 'Git must inspect the supplied checkout');
      calls.git.push(args);
      if (gitFailure?.command === args[0]) return gitFailure.result;
      if (args.join(' ') === 'rev-parse HEAD') {
        headReads += 1;
        return { status: 0, stdout: `${typeof head === 'function' ? head(headReads) : head}\n` };
      }
      if (args.join(' ') === 'remote get-url origin') return { status: 0, stdout: `${remote}\n` };
      if (args.join(' ') === 'diff --quiet HEAD --') {
        cleanChecks += 1;
        return { status: (typeof dirty === 'function' ? dirty(cleanChecks) : dirty) ? 1 : 0 };
      }
      throw new Error('Unexpected Git operation in the isolated fixture');
    },
    fetchImpl: async (url, options) => {
      const next = replies[Math.min(calls.http.length, replies.length - 1)];
      calls.http.push({ url: new URL(url), options });
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next({ advance: ms => { elapsed += ms; } }) : next;
    },
    sleep: async ms => { calls.sleeps.push(ms); elapsed += ms; },
    now: () => elapsed,
    log: message => calls.logs.push(message),
    ...settings,
  };
  return {
    calls,
    advance: ms => { elapsed += ms; },
    elapsed: () => elapsed,
    execute: (overrides = {}) => runGithubCiGate({ ...options, ...overrides }),
  };
}

test('waits for discovery and queued work, then permits the current commit after CI succeeds', async () => {
  const f = fixture({ replies: [
    response([]),
    response([workflow({ status: 'queued', conclusion: null })]),
    response([workflow({ status: 'queued', conclusion: null })]),
    response([workflow({ status: 'in_progress', conclusion: null })]),
    response([workflow()]),
  ] });
  const result = await f.execute();
  assert.equal(result.sha, SHA);
  assert.equal(result.repository, 'example/monitor');
  assert.equal(result.runId, 100);
  assert.equal(result.runAttempt, 1);
  assert.equal(f.calls.http.length, 5);
  assert.deepEqual(f.calls.sleeps, [30_000, 30_000, 30_000, 30_000]);
  assert.equal(f.calls.logs.length, 4, 'unchanged queue status must not spam waiting messages');
});

test('requests the push workflow for the exact SHA without filtering away unsuccessful runs', async () => {
  const f = fixture({ env: { WORKERS_CI: '1', WORKERS_CI_BUILD_UUID: 'synthetic-build' } });
  await f.execute();
  const { url, options } = f.calls.http[0];
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(url.pathname, '/repos/example/monitor/actions/workflows/ci.yml/runs');
  assert.deepEqual(Object.fromEntries(url.searchParams), { head_sha: SHA, event: 'push', per_page: '100' });
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error', 'credentials must not follow redirects');
  assert.ok(options.signal instanceof AbortSignal, 'the external request must have a timeout signal');
  assert.equal(new Headers(options.headers).has('authorization'), false, 'public CI must work without secrets');
});

for (const remote of [
  'https://github.com/example/monitor',
  'git@github.com:example/monitor.git',
  'ssh://git@github.com/example/monitor.git',
]) {
  test(`accepts the supported GitHub remote form ${remote.split(':')[0]}`, async () => {
    const result = await fixture({ remote }).execute();
    assert.equal(result.repository, 'example/monitor');
  });
}

test('missing CI exhausts the bounded twelve-minute wait without falling back to verification', async () => {
  const f = fixture({ replies: [response([])] });
  await assert.rejects(f.execute(), { code: 'WAIT_TIMEOUT' });
  assert.equal(f.elapsed(), 720_000);
  assert.equal(f.calls.http.length, 24);
  assert.ok(f.calls.sleeps.every(ms => ms === 30_000));
});

test('the last polling sleep cannot exceed the remaining deadline', async () => {
  const f = fixture({ timeoutMs: 75_000, replies: [response([])] });
  await assert.rejects(f.execute(), { code: 'WAIT_TIMEOUT' });
  assert.deepEqual(f.calls.sleeps, [30_000, 30_000, 15_000]);
  assert.equal(f.elapsed(), 75_000);
});

for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required']) {
  test(`completed ${conclusion} CI stops immediately`, async () => {
    const f = fixture({ replies: [response([workflow({ conclusion })])] });
    await assert.rejects(f.execute(), { code: 'CI_NOT_SUCCESSFUL' });
    assert.equal(f.calls.http.length, 1);
    assert.equal(f.calls.sleeps.length, 0);
  });
}

test('an old success cannot mask a newer failed run, regardless of API array ordering', async () => {
  const f = fixture({ replies: [response([
    workflow({ id: 99 }),
    workflow({ id: 101, conclusion: 'failure' }),
    workflow({ id: 100 }),
  ])] });
  await assert.rejects(f.execute(), { code: 'CI_NOT_SUCCESSFUL' });
});

test('a newer queued run cannot reuse an older success', async () => {
  const f = fixture({ timeoutMs: 60_000, replies: [response([
    workflow({ id: 99 }),
    workflow({ status: 'queued', conclusion: null }),
  ])] });
  await assert.rejects(f.execute(), { code: 'WAIT_TIMEOUT' });
  assert.equal(f.calls.http.length, 2);
});

test('a rerun waits for the current attempt instead of accepting its previous success', async () => {
  const f = fixture({ replies: [
    response([workflow(), workflow({ run_attempt: 2, status: 'in_progress', conclusion: null })]),
    response([workflow({ run_attempt: 2 })]),
  ] });
  const result = await f.execute();
  assert.equal(result.runAttempt, 2);
  assert.equal(f.calls.http.length, 2);
});

for (const [label, observed, gap] of [
  ['run', { id: 101 }, false],
  ['attempt', { run_attempt: 2 }, false],
  ['run after a temporary discovery gap', { id: 101 }, true],
]) {
  test(`an older successful ${label} cannot replace newer work observed in an earlier poll`, async () => {
    const f = fixture({ replies: [
      response([workflow({ ...observed, status: 'in_progress', conclusion: null })]),
      ...(gap ? [response([])] : []),
      response([workflow()]),
    ] });
    await assert.rejects(f.execute(), { code: 'STALE_RESPONSE' });
    assert.equal(f.calls.http.length, gap ? 3 : 2);
    assert.equal(f.calls.logs.some(message => message.includes('CI passed')), false);
  });
}

test('discovery gaps still allow the observed run or a newer run to complete', async () => {
  for (const id of [101, 102]) {
    const f = fixture({ replies: [
      response([workflow({ id: 101, status: 'queued', conclusion: null })]),
      response([]),
      response([workflow({ id })]),
    ] });
    assert.equal((await f.execute()).runId, id);
    assert.equal(f.calls.http.length, 3);
  }
});

test('only the latest run determines the result, so a later success supersedes an old failure', async () => {
  const f = fixture({ replies: [response([workflow({ id: 101 }), workflow({ conclusion: 'failure' })])] });
  assert.equal((await f.execute()).runId, 101);
});

for (const [label, overrides] of [
  ['SHA', { head_sha: OTHER_SHA }],
  ['repository', { head_repository: { full_name: 'example/other' } }],
  ['workflow', { path: '.github/workflows/release-agent.yml' }],
  ['event', { event: 'pull_request' }],
]) {
  test(`a success with the wrong ${label} is never accepted`, async () => {
    const f = fixture({ replies: [response([workflow(overrides)])] });
    await assert.rejects(f.execute(), { code: 'RUN_MISMATCH' });
    assert.equal(f.calls.sleeps.length, 0);
  });
}

for (const [label, settings, code] of [
  ['invalid Git SHA', { head: 'not-a-commit' }, 'INVALID_COMMIT'],
  ['mismatched environment SHA', { env: { WORKERS_CI_COMMIT_SHA: OTHER_SHA } }, 'COMMIT_MISMATCH'],
  ['malformed environment SHA', { env: { WORKERS_CI_COMMIT_SHA: 'short' } }, 'COMMIT_MISMATCH'],
  ['tracked or staged changes', { dirty: true }, 'DIRTY_WORKTREE'],
  ['non-GitHub origin', { remote: 'https://example.invalid/example/monitor.git' }, 'INVALID_REMOTE'],
  ['insecure origin', { remote: 'http://github.com/example/monitor.git' }, 'INVALID_REMOTE'],
  ['missing Git metadata', { gitFailure: { command: 'rev-parse', result: { status: 128 } } }, 'GIT_CHECK_FAILED'],
  ['failed diff command', { gitFailure: { command: 'diff', result: { status: 128 } } }, 'GIT_CHECK_FAILED'],
]) {
  test(`${label} fails before any HTTP request`, async () => {
    const f = fixture(settings);
    await assert.rejects(f.execute(), { code });
    assert.equal(f.calls.http.length, 0);
  });
}

test('a matching optional Workers SHA works without requiring a branch variable', async () => {
  const result = await fixture({ env: { WORKERS_CI_COMMIT_SHA: SHA } }).execute();
  assert.equal(result.sha, SHA);
});

for (const [label, settings, code] of [
  ['checkout changes', { head: count => count === 1 ? SHA : OTHER_SHA }, 'COMMIT_MISMATCH'],
  ['tracked files change', { dirty: count => count > 1 }, 'DIRTY_WORKTREE'],
]) {
  test(`${label} while waiting stops approval even after a successful CI response`, async () => {
    const f = fixture({ ...settings, replies: [
      response([workflow({ status: 'queued', conclusion: null })]), response([workflow()]),
    ] });
    await assert.rejects(f.execute(), { code });
    assert.equal(f.calls.http.length, 2);
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} fails closed without reading or printing the response body`, async () => {
    let bodyRead = false;
    const f = fixture({ replies: [{ status, json: async () => { bodyRead = true; return {}; } }] });
    await assert.rejects(f.execute(), { code: 'HTTP_ERROR' });
    assert.equal(bodyRead, false);
    assert.equal(f.calls.http.length, 1);
    assert.equal(f.calls.sleeps.length, 0);
  });
}

for (const [label, body] of [
  ['missing run array', {}],
  ['invalid count', { total_count: '1', workflow_runs: [workflow()] }],
  ['incomplete first page', { total_count: 2, workflow_runs: [workflow()] }],
  ['empty first page with reported runs', { total_count: 1, workflow_runs: [] }],
  ['missing run identity', { total_count: 1, workflow_runs: [workflow({ id: undefined })] }],
  ['missing run attempt', { total_count: 1, workflow_runs: [workflow({ run_attempt: undefined })] }],
  ['unknown run status', { total_count: 1, workflow_runs: [workflow({ status: 'unknown' })] }],
  ['completed without conclusion', { total_count: 1, workflow_runs: [workflow({ conclusion: null })] }],
]) {
  test(`malformed API data (${label}) fails closed`, async () => {
    const f = fixture({ replies: [{ status: 200, json: async () => body }] });
    await assert.rejects(f.execute(), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.sleeps.length, 0);
  });
}

test('invalid JSON cannot become an absent run or a successful gate', async () => {
  const f = fixture({ replies: [{ status: 200, json: async () => { throw new SyntaxError('synthetic invalid JSON'); } }] });
  await assert.rejects(f.execute(), { code: 'INVALID_RESPONSE' });
});

for (const error of [new Error('synthetic network failure'), new DOMException('synthetic request timeout', 'TimeoutError')]) {
  test(`a ${error.name} from fetch stops rather than retries or deploys`, async () => {
    const f = fixture({ replies: [error] });
    await assert.rejects(f.execute(), { code: 'NETWORK_ERROR' });
    assert.equal(f.calls.http.length, 1);
    assert.equal(f.calls.sleeps.length, 0);
  });
}

test('a response arriving after the total deadline cannot authorize deployment', async () => {
  const f = fixture({ replies: [({ advance }) => { advance(720_001); return response([workflow()]); }] });
  await assert.rejects(f.execute(), { code: 'WAIT_TIMEOUT' });
});

test('a final checkout check that exhausts the deadline cannot authorize deployment', async () => {
  const f = fixture({ head: count => {
    if (count > 1) f.advance(720_001);
    return SHA;
  } });
  await assert.rejects(f.execute(), { code: 'WAIT_TIMEOUT' });
});

test('each request timeout is capped at fifteen seconds and the remaining overall budget', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  await fixture().execute();
  await fixture({ timeoutMs: 5_000 }).execute();
  assert.deepEqual(timeouts, [15_000, 5_000]);
});

for (const tokenName of ['GH_TOKEN', 'GITHUB_TOKEN']) {
  test(`optional ${tokenName} authenticates without appearing in logs`, async () => {
    const sensitive = randomUUID();
    const f = fixture({ env: { [tokenName]: sensitive }, remote: `https://user:${sensitive}@github.com/example/monitor.git` });
    await f.execute();
    assert.equal(new Headers(f.calls.http[0].options.headers).get('authorization'), `Bearer ${sensitive}`);
    assert.equal(f.calls.logs.join('\n').includes(sensitive), false);
    assert.equal(f.calls.logs.join('\n').includes('https://user:'), false);
  });
}

test('raw network failures, API bodies, and Git stderr never appear in gate errors or logs', async () => {
  const sensitive = randomUUID();
  const cases = [
    fixture({ replies: [new Error(sensitive)] }),
    fixture({ replies: [{ status: 200, json: async () => ({ message: sensitive }) }] }),
    fixture({ gitFailure: { command: 'remote', result: { status: 128, stderr: sensitive } } }),
    fixture({ remote: `https://user:${sensitive}@example.invalid/example/monitor.git` }),
  ];
  for (const f of cases) {
    await assert.rejects(f.execute(), error => {
      assert.equal(String(error).includes(sensitive), false);
      assert.equal(f.calls.logs.join('\n').includes(sensitive), false);
      return true;
    });
  }
});
