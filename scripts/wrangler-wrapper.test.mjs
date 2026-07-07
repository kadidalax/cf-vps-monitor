import assert from 'node:assert/strict';
import { resolveWrapperCommand } from './wrangler-wrapper.mjs';

assert.deepEqual(resolveWrapperCommand(['deploy']), {
  type: 'managed-deploy',
  mode: 'deploy',
  args: [],
});

assert.deepEqual(resolveWrapperCommand(['deploy', '--name', 'demo']), {
  type: 'managed-deploy',
  mode: 'deploy',
  args: ['--name', 'demo'],
});

assert.deepEqual(resolveWrapperCommand(['versions', 'upload', '--dry-run']), {
  type: 'managed-deploy',
  mode: 'versions-upload',
  args: ['--dry-run'],
});

assert.deepEqual(resolveWrapperCommand(['secret', 'list']), {
  type: 'passthrough',
  args: ['secret', 'list'],
});
