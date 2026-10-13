import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMatrices } from '../../../scripts/sandbox/generate-e2e-matrix.mjs';

const matrix = fileURLToPath(new URL('../../../scripts/sandbox/generate-e2e-matrix.mjs', import.meta.url));
const picker = fileURLToPath(new URL('../../../scripts/sandbox/pick-release-tags.sh', import.meta.url));

test('failed baseline selection renders missing coverage instead of crashing on empty output', () => {
  const result = spawnSync(process.execPath, [matrix, '--format', 'results', '--tags', ''], {
    encoding: 'utf8', input: JSON.stringify({ name: 'Pick release tags', conclusion: 'failure' }) + '\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no installation.update legs executed/i);
  assert.doesNotMatch(result.stdout, /upgrade passed|[0-9]+ passed/i);
});

test('upstream release labels carry immutable install commits and source through every OS matrix', () => {
  const sha = 'a'.repeat(40);
  for (const osName of ['linux', 'windows', 'macos']) {
    const entries = buildMatrices([{ os: osName, install: 'installer-script', update: 'hermes-update' }], [
      { ref: 'v0.21.6', desktop: true, sha, repository: 'NousResearch/hermes-agent' },
    ])[osName].include;
    assert.equal(entries[0].install_ref, sha);
    assert.equal(entries[0].baseline_repository, 'NousResearch/hermes-agent');
    assert.match(entries[0].name, /v0[.]21[.]6 -> HEAD/);
    assert.equal(entries[1].install_ref, 'HEAD');
    assert.equal(entries[1].baseline_repository, '');
    assert.equal(entries[1].update_ref, 'NEXT');
  }
});

test('local stable sampling follows chronology through the calendar-to-semver transition', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-tag-sampling-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    for (const [index, tag] of ['v2026.9.24', 'v0.21.6', 'v0.21.7+canary.test'].entries()) {
      writeFileSync(path.join(dir, 'version'), tag);
      git('add', 'version');
      const date = '2026-10-0' + (index + 1) + 'T00:00:00Z';
      execFileSync('git', ['-C', dir, 'commit', '-qm', tag], {
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
      git('tag', tag);
    }
    const result = spawnSync('bash', [picker, '--repo', dir, '--count', '1'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['v0.21.6']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
