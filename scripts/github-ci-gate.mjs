import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = dirname(dirname(modulePath));
const commitPattern = /^[a-f0-9]{40}$/i;
const pendingStatuses = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const conclusions = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale', 'startup_failure']);

class GithubCiGateError extends Error {
  constructor(code, message) {
    super(`GitHub CI gate: ${message}`);
    this.name = 'GithubCiGateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GithubCiGateError(code, message);
}

function repositoryFromRemote(raw) {
  let path;
  const ssh = /^git@github\.com:([^\s?#]+)$/i.exec(raw);
  if (ssh) {
    path = ssh[1];
  } else {
    let url;
    try { url = new URL(raw); } catch { fail('INVALID_REMOTE', 'origin must be a GitHub HTTPS or SSH remote.'); }
    const https = url.protocol === 'https:' && !url.port;
    const sshUrl = url.protocol === 'ssh:' && url.username === 'git' && !url.password && (!url.port || url.port === '22');
    if (url.hostname !== 'github.com' || (!https && !sshUrl) || url.search || url.hash) {
      fail('INVALID_REMOTE', 'origin must be a GitHub HTTPS or SSH remote.');
    }
    path = url.pathname.slice(1);
  }
  const parts = path.replace(/\/$/, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(parts[0])
      || !/^[a-z0-9_.-]{1,100}$/i.test(parts[1]) || parts[1] === '.' || parts[1] === '..') {
    fail('INVALID_REMOTE', 'origin does not identify one GitHub repository.');
  }
  return parts.join('/').toLowerCase();
}

function latestWorkflowRun(payload, sha, repository) {
  if (!payload || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0
      || !Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > 100
      || payload.workflow_runs.length !== Math.min(payload.total_count, 100)) {
    fail('INVALID_RESPONSE', 'GitHub returned an invalid workflow-run list.');
  }
  let latest;
  const identities = new Set();
  for (const run of payload.workflow_runs) {
    if (!run || !Number.isSafeInteger(run.id) || run.id <= 0
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0
        || typeof run.head_sha !== 'string' || !commitPattern.test(run.head_sha)
        || typeof run.head_repository?.full_name !== 'string'
        || typeof run.event !== 'string' || typeof run.path !== 'string') {
      fail('INVALID_RESPONSE', 'GitHub returned invalid workflow-run identity fields.');
    }
    if (run.head_sha !== sha || run.head_repository.full_name.toLowerCase() !== repository
        || run.event !== 'push' || run.path !== '.github/workflows/ci.yml') {
      fail('RUN_MISMATCH', 'GitHub returned a run for a different commit, repository, event, or workflow.');
    }
    if (run.status === 'completed' ? !conclusions.has(run.conclusion)
      : !pendingStatuses.has(run.status) || run.conclusion !== null) {
      fail('INVALID_RESPONSE', 'GitHub returned an invalid workflow-run status.');
    }
    const identity = `${run.id}:${run.run_attempt}`;
    if (identities.has(identity)) fail('INVALID_RESPONSE', 'GitHub returned duplicate workflow-run attempts.');
    identities.add(identity);
    if (!latest || run.id > latest.id || (run.id === latest.id && run.run_attempt > latest.run_attempt)) latest = run;
  }
  return latest;
}

/** Wait for the latest push CI run for this clean checkout; never build or deploy. */
export async function runGithubCiGate({
  root = defaultRoot,
  env = process.env,
  run = spawnSync,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  now = Date.now,
  log = console.log,
  timeoutMs = 12 * 60_000,
  pollMs = 30_000,
} = {}) {
  try {
    if (typeof root !== 'string' || !root || !env || typeof env !== 'object'
        || ![run, fetchImpl, sleep, now, log].every(fn => typeof fn === 'function')
        || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
        || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
      fail('INVALID_OPTIONS', 'invalid checkout, I/O, or wait configuration.');
    }
    const startedAt = now();
    if (!Number.isFinite(startedAt)) fail('INVALID_OPTIONS', 'the wait clock is unavailable.');
    const deadline = startedAt + timeoutMs;
    const git = args => {
      let result;
      try {
        result = run('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe', shell: false,
          windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
      } catch { fail('GIT_CHECK_FAILED', 'could not inspect the current Git checkout.'); }
      if (args[0] === 'diff' && result?.status === 1) {
        fail('DIRTY_WORKTREE', 'tracked files or the index differ from HEAD; deployment stopped.');
      }
      if (!result || result.status !== 0 || result.error) fail('GIT_CHECK_FAILED', 'could not inspect the current Git checkout.');
      return typeof result.stdout === 'string' ? result.stdout.trim() : '';
    };
    const readCommit = () => {
      const value = git(['rev-parse', 'HEAD']);
      if (!commitPattern.test(value)) fail('INVALID_COMMIT', 'Git HEAD must be a full 40-character commit SHA.');
      return value.toLowerCase();
    };
    const sha = readCommit();
    if (env.WORKERS_CI_COMMIT_SHA !== undefined
        && (typeof env.WORKERS_CI_COMMIT_SHA !== 'string'
          || !commitPattern.test(env.WORKERS_CI_COMMIT_SHA.trim())
          || env.WORKERS_CI_COMMIT_SHA.trim().toLowerCase() !== sha)) {
      fail('COMMIT_MISMATCH', 'the Workers build commit differs from Git HEAD.');
    }
    const repository = repositoryFromRemote(git(['remote', 'get-url', 'origin']));
    git(['diff', '--quiet', 'HEAD', '--']);

    const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`);
    url.search = new URLSearchParams({ head_sha: sha, event: 'push', per_page: '100' }).toString();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cf-vps-monitor-ci-gate' };
    const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    let previousState;
    let newestObserved;
    while (true) {
      const remaining = deadline - now();
      if (!Number.isFinite(remaining) || remaining <= 0) fail('WAIT_TIMEOUT', 'timed out waiting for successful CI; deployment stopped.');
      const signal = AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.floor(remaining))));
      let response;
      try {
        response = await fetchImpl(url.href, { method: 'GET', headers, signal, redirect: 'error', cache: 'no-store' });
      } catch { fail('NETWORK_ERROR', 'the GitHub request failed or timed out; deployment stopped.'); }
      if (!Number.isInteger(response?.status)) fail('INVALID_RESPONSE', 'GitHub returned an invalid HTTP response.');
      if (response.status !== 200) fail('HTTP_ERROR', `GitHub returned HTTP ${response.status}; deployment stopped.`);
      let payload;
      try { payload = await response.json(); } catch {
        if (signal.aborted) fail('NETWORK_ERROR', 'the GitHub response timed out; deployment stopped.');
        fail('INVALID_RESPONSE', 'GitHub returned an unreadable response; deployment stopped.');
      }
      if (now() >= deadline) fail('WAIT_TIMEOUT', 'timed out waiting for successful CI; deployment stopped.');
      const latest = latestWorkflowRun(payload, sha, repository);
      // API snapshots can lag behind an earlier poll. Once a rerun is seen,
      // an older success must never regain permission to publish this checkout.
      if (latest && newestObserved && (latest.id < newestObserved.id
          || (latest.id === newestObserved.id && latest.run_attempt < newestObserved.run_attempt))) {
        fail('STALE_RESPONSE', 'GitHub returned an older CI run or attempt than previously observed; deployment stopped.');
      }
      if (latest) newestObserved = latest;
      if (latest?.status === 'completed') {
        if (latest.conclusion !== 'success') {
          fail('CI_NOT_SUCCESSFUL', `latest CI run ${latest.id} attempt ${latest.run_attempt} completed with ${latest.conclusion}; deployment stopped.`);
        }
        if (readCommit() !== sha) fail('COMMIT_MISMATCH', 'Git HEAD changed while waiting for CI; deployment stopped.');
        git(['diff', '--quiet', 'HEAD', '--']);
        const completedAt = now();
        if (!Number.isFinite(completedAt) || completedAt >= deadline) {
          fail('WAIT_TIMEOUT', 'timed out while confirming the tested checkout; deployment stopped.');
        }
        log(`GitHub CI passed for ${sha.slice(0, 7)} (run ${latest.id}, attempt ${latest.run_attempt}).`);
        return { sha, repository, runId: latest.id, runAttempt: latest.run_attempt };
      }
      const state = latest ? `${latest.id}:${latest.run_attempt}:${latest.status}` : 'missing';
      if (state !== previousState) {
        log(latest
          ? `Waiting for GitHub CI ${sha.slice(0, 7)}: run ${latest.id}, attempt ${latest.run_attempt}, ${latest.status}.`
          : `Waiting for the GitHub push CI run for ${sha.slice(0, 7)} to appear.`);
        previousState = state;
      }
      const delay = Math.min(pollMs, deadline - now());
      if (delay > 0) await sleep(delay);
    }
  } catch (error) {
    if (error instanceof GithubCiGateError) throw error;
    fail('INTERNAL_ERROR', 'an unexpected check failed; deployment stopped.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try { await runGithubCiGate(); } catch (error) {
    console.error(error instanceof GithubCiGateError ? error.message : 'GitHub CI gate failed; deployment stopped.');
    process.exitCode = 1;
  }
}
