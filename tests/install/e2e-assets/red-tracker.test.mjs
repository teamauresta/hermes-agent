import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tracker = fileURLToPath(new URL('./red-tracker.mjs', import.meta.url));

// Exercise the CLI with a local GitHub executable, never live credentials or writes.
function runTracker(scenario, args = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-red-tracker-'));
  const calls = path.join(dir, 'calls.jsonl');
  writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const s = JSON.parse(process.env.TRACKER_SCENARIO);
fs.appendFileSync(process.env.TRACKER_CALLS, JSON.stringify(args) + '\\n');
const route = args[1];
if (args[0] === 'api' && route === 'repos/example/fork') {
  if (s.repoError) { console.error('repository lookup failed'); process.exit(1); }
  console.log(JSON.stringify({has_issues: s.hasIssues}));
} else if (args[0] === 'api' && route === 'repos/example/fork/actions/runs/42') {
  console.log(JSON.stringify({conclusion:s.conclusion || 'failure',html_url:'https://example/run/42',head_sha:'abc123456789',created_at:'2026-10-13T00:00:00Z'}));
} else if (args[0] === 'api' && args.includes('--paginate')) {
  if (s.conclusion !== 'success') console.log(JSON.stringify({name:'Install',conclusion:'failure',html_url:'https://example/job/1',steps:[{name:'Install HEAD',conclusion:'failure'}]}));
} else if (args[0] === 'api' && route.startsWith('repos/example/fork/issues?')) {
  console.log(JSON.stringify(s.openIssue ? [{number:7}] : []));
} else {
  if (!s.hasIssues) { console.error('Issues are disabled for this repo'); process.exit(1); }
  console.log(args[0] === 'issue' && route === 'create' ? 'https://example/issue/7' : '{}');
}
`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, [tracker, '--run-id', '42', ...args], {
      encoding: 'utf8',
      env: { PATH: `${dir}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'example/fork',
        TRACKER_SCENARIO: JSON.stringify(scenario), TRACKER_CALLS: calls },
    });
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Issues-disabled repositories succeed without querying runs or attempting issue writes', () => {
  const result = runTracker({ hasIssues: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /issues.*disabled/i);
  assert.deepEqual(result.calls, [['api', 'repos/example/fork']]);
});

test('repository lookup errors remain failures, not silent skips', () => {
  const result = runTracker({ hasIssues: true, repoError: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository lookup failed/);
  assert.equal(result.calls.length, 1);
});

test('enabled red repository opens one tracker and creates its label', () => {
  const result = runTracker({ hasIssues: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((a) => a[0] === 'label' && a[1] === 'create').length, 1);
  assert.equal(result.calls.filter((a) => a[0] === 'issue' && a[1] === 'create').length, 1);
});

test('enabled red repository updates an existing tracker instead of opening another', () => {
  const result = runTracker({ hasIssues: true, openIssue: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((a) => a.includes('PATCH') && a.includes('repos/example/fork/issues/7')).length, 1);
  assert.equal(result.calls.filter((a) => a[0] === 'issue').length, 0);
});

test('enabled green repository closes an existing tracker', () => {
  const result = runTracker({ hasIssues: true, openIssue: true, conclusion: 'success' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.filter((a) => a[0] === 'issue').map((a) => a[1]), ['comment', 'close']);
});

test('dry-run preserves read-only planning when Issues are enabled', () => {
  const result = runTracker({ hasIssues: true }, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-> open/);
  assert.ok(result.calls.every((a) => a[0] === 'api' && !a.includes('PATCH')));
});

test('green repository without an open tracker does not write', () => {
  const result = runTracker({ hasIssues: true, conclusion: 'success' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-> none/);
  assert.ok(result.calls.every((a) => a[0] === 'api' && !a.includes('PATCH')));
});
