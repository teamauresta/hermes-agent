import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { listPublishedReleases, pickBaselines, prepareBaseline, publishedReleases, runCommand, spread } from './release-baselines.mjs';

const repository = 'example/upstream';
const sourceUrl = 'https://github.com/' + repository + '.git';
const cli = fileURLToPath(new URL('./release-baselines.mjs', import.meta.url));
const release = (tag_name, day, extra = {}) => ({ tag_name, draft: false, prerelease: false, published_at: '2026-10-' + String(day).padStart(2, '0') + 'T00:00:00Z', ...extra });

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-baselines-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'upstream');
  const repo = path.join(root, 'checkout');
  mkdirSync(source);
  // Only disposable repositories are configured. No global Git state or real
  // checkout tags/branches are modified by these tests.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Baseline Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Baseline Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '-b', 'main');
  let serial = 0;
  const commit = (desktop = false) => {
    writeFileSync(path.join(source, 'history'), String(++serial));
    if (desktop) {
      mkdirSync(path.join(source, 'apps/desktop'), { recursive: true });
      writeFileSync(path.join(source, 'apps/desktop/package.json'), '{}');
    }
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'fixture ' + serial);
    return git(source, 'rev-parse', 'HEAD');
  };
  const old = commit();
  git(source, 'tag', 'v2026.1.1');
  const middle = commit();
  git(source, 'tag', 'v0.9.0');
  const newest = commit(true);
  git(source, 'tag', '-a', 'v1.0.0', '-m', 'annotated published tag');
  git(source, 'tag', 'v1.0.0.1');
  git(source, 'tag', 'v8.0.0'); // Exists, but unpublished.
  const head = commit(true);
  git(source, 'tag', 'v1.1.0');
  git(root, 'clone', '--no-tags', source, repo);
  const future = commit(true);
  git(source, 'tag', 'v1.2.0');
  git(source, 'checkout', '-b', 'diverged', old);
  const diverged = commit();
  git(source, 'tag', 'v2.0.0');
  const pages = [[release('v1.2.0', 7), release('v1.0.0', 3), release('v3.0.0', 9, { prerelease: true }), release('canary', 10)],
    [release('v2.0.0', 8), release('v1.1.0', 6), release('v2026.1.1', 1), release('v0.9.0', 2),
      release('v8.0.0', 11, { published_at: null }), release('v9.0.0', 12, { draft: true })]];
  const calls = [];
  const warnings = [];
  const run = (command, args, options) => {
    calls.push({ command, args });
    if (command === 'gh') return { status: 0, stdout: JSON.stringify(pages) };
    assert.equal(command, 'git');
    // Inject only the transport destination, not fetch, commit peeling,
    // ancestry or tree answers: all those operations execute real Git.
    const actual = args.map((arg) => arg === sourceUrl ? source : arg);
    const result = spawnSync('git', actual, { ...options, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout };
  };
  return { root, source, repo, git, env, pages, calls, warnings, old, middle, newest, head, future, diverged,
    options: { repository, repo, count: 20 }, deps: { run, warn: (message) => warnings.push(message) } };
}

test('published metadata excludes drafts, prereleases, canary and unpublished tags; chronological mixed versions', () => {
  const pages = [[release('v1.0.0', 4), release('v9999.1.1', 1), release('v1.0.0-rc1', 5)],
    [release('v0.8.0.2', 2), release('canary', 6), release('v2.0.0', 7, { prerelease: true }),
      release('v3.0.0', 8, { draft: true }), release('v4.0.0', 9, { published_at: null })]];
  const refs = publishedReleases(pages).map((r) => r.ref);
  assert.deepEqual(refs, ['v9999.1.1', 'v0.8.0.2', 'v1.0.0']);
  assert.deepEqual(spread(refs, 1), ['v1.0.0']);
  assert.deepEqual(spread([0, 1, 2, 3, 4, 5], 3), [0, 3, 5]);
  assert.deepEqual(spread(refs, 20), refs);
});

test('real fetch resolves published annotated tags, excludes no-change/future/diverged, and preserves local tags', (t) => {
  const f = fixture(t);
  // An identically named local tag is not provenance and must not win.
  f.git(f.repo, 'tag', 'v1.0.0', f.old);
  f.git(f.repo, 'tag', 'v9999.9.9', f.head);
  const before = f.git(f.repo, 'show-ref', '--tags');
  const result = pickBaselines(f.options, f.deps);
  const initialFetches = f.calls.filter((call) => call.args[0] === 'fetch');
  assert.equal(initialFetches.length, 1, 'one transport request per selection');
  for (const refspec of initialFetches[0].args.slice(4)) {
    assert.ok(refspec.startsWith('+refs/tags/v'));
    assert.ok(refspec.split(':')[1].startsWith('refs/remotes/install-baselines/v'));
  }
  assert.deepEqual(result, [
    { ref: 'v2026.1.1', desktop: false, sha: f.old, repository },
    { ref: 'v0.9.0', desktop: false, sha: f.middle, repository },
    { ref: 'v1.0.0', desktop: true, sha: f.newest, repository },
  ]);
  assert.equal(f.git(f.repo, 'show-ref', '--tags'), before);
  assert.equal(f.warnings.length, 3);
  assert.match(f.warnings.join('\n'), /no-change/);
  assert.equal(f.warnings.filter((message) => message.includes('not an ancestor')).length, 2);
  assert.deepEqual(pickBaselines({ ...f.options, count: 1 }, f.deps).map((r) => r.ref), ['v1.0.0']);
  const gh = f.calls.find((call) => call.command === 'gh');
  assert.deepEqual(gh.args, ['api', '--hostname', 'github.com', 'repos/example/upstream/releases?per_page=100', '--paginate', '--slurp']);
  const fetches = f.calls.filter((call) => call.args[0] === 'fetch');
  assert.ok(fetches.length > 0);
  for (const { args } of fetches) {
    assert.equal(args[3], sourceUrl);
    assert.ok(args.includes('--no-tags'));
    assert.match(args[4], /^\+refs\/tags\/v[0-9.]+:refs\/remotes\/install-baselines\/v[0-9.]+$/);
    assert.doesNotMatch(args[4].split(':')[1], /^refs\/tags\//);
  }
});

test('explicit install ref must be published and compatible; excludes candidate aliases by SHA', (t) => {
  const f = fixture(t);
  assert.deepEqual(pickBaselines({ ...f.options, installRef: 'v0.9.0' }, f.deps).map((r) => r.sha), [f.middle]);
  for (const ref of ['v8.0.0', 'v9.0.0', 'v3.0.0', 'v7.0.0']) {
    assert.throws(() => pickBaselines({ ...f.options, installRef: ref }, f.deps), /not a published stable release/);
  }
  for (const ref of ['v1.1.0', 'v1.2.0', 'v2.0.0']) {
    assert.throws(() => pickBaselines({ ...f.options, installRef: ref }, f.deps), /install-ref cannot be used/);
  }
  assert.throws(() => pickBaselines({ ...f.options, installRef: 'v1.0.0', excludeRef: 'v1.0.0' }, f.deps), /excluded/);
  // The candidate alias exists upstream but need not have a published release.
  assert.deepEqual(pickBaselines({ ...f.options, excludeRef: 'v1.0.0.1' }, f.deps).map((r) => r.sha), [f.old, f.middle]);
  assert.throws(() => pickBaselines({ ...f.options, installRef: 'v1.0.0', excludeRef: 'v1.0.0.1' }, f.deps), /excluded candidate/);
  assert.throws(() => pickBaselines({ ...f.options, excludeRef: 'v777.0.0' }, f.deps), /git failed/);
});

test('prepare fetches exact immutable pin and survives tag movement; source bare clone retains baseline', (t) => {
  const f = fixture(t);
  const [picked] = pickBaselines({ ...f.options, count: 1 }, f.deps);
  f.git(f.source, 'tag', '-f', 'v1.0.0', f.future);
  assert.deepEqual(prepareBaseline({ repository, repo: f.repo, sha: picked.sha }, f.deps), { repository, sha: f.newest });
  assert.equal(f.git(f.repo, 'tag', '--list'), '');
  assert.equal(f.git(f.repo, 'rev-parse', 'refs/remotes/install-baselines/sha-' + picked.sha), picked.sha);
  const bare = path.join(f.root, 'driver-source.git');
  f.git(f.root, 'clone', '--bare', f.repo, bare);
  assert.equal(f.git(bare, 'rev-parse', picked.sha + '^{commit}'), picked.sha);
  for (const sha of [f.head, f.future, f.diverged]) {
    assert.throws(() => prepareBaseline({ repository, repo: f.repo, sha }, f.deps), /pinned baseline cannot be used/);
  }
  assert.throws(() => prepareBaseline({ repository, repo: f.repo, sha: 'a'.repeat(40) }, f.deps), /git failed/);
});

test('API, fetch, ancestry and tree errors fail closed rather than produce green matrices', (t) => {
  const f = fixture(t);
  for (const response of ['', '{}', '[{}]', '[[{}]]']) {
    assert.throws(() => listPublishedReleases(repository, () => ({ status: 0, stdout: response })), /invalid/);
  }
  assert.throws(() => listPublishedReleases(repository, () => ({ status: 1, stdout: '' })), /gh failed/);
  assert.throws(() => publishedReleases([[release('v1.0.0', 1, { published_at: 'bad-date' })]]), /publication time/);
  assert.throws(() => publishedReleases([[release('v1.0.0', 1), release('v1.0.0', 1)]]), /duplicate/);
  for (const failing of ['fetch', 'merge-base', 'ls-tree']) {
    const run = (command, args, options) => command === 'git' && args[0] === failing
      ? { status: 128, stdout: '' } : f.deps.run(command, args, options);
    assert.throws(() => pickBaselines(f.options, { ...f.deps, run }), /git .*failed/);
  }
  f.pages.splice(0, f.pages.length, [release('v1.1.0', 1)]);
  assert.throws(() => pickBaselines(f.options, f.deps), /no compatible published stable baseline/);
  f.pages.splice(0, f.pages.length, []);
  assert.throws(() => pickBaselines(f.options, f.deps), /no compatible published stable baseline/);
  f.pages.splice(0, f.pages.length, [release('v55.0.0', 1)]);
  assert.throws(() => pickBaselines(f.options, f.deps), /git failed/);
});

test('shallow history and mismatched fetched pins are rejected', (t) => {
  const f = fixture(t);
  const shallow = path.join(f.root, 'shallow');
  f.git(f.root, 'clone', '--depth', '1', '--no-tags', 'file://' + f.repo, shallow);
  assert.throws(() => pickBaselines({ ...f.options, repo: shallow }, f.deps), /full checkout history required/);
  assert.throws(() => prepareBaseline({ repository, repo: shallow, sha: f.old }, f.deps), /full checkout history required/);
  const run = (command, args, options) => args[0] === 'rev-parse' && args[2]?.startsWith('refs/remotes/install-baselines/sha-')
    ? { status: 0, stdout: f.middle } : f.deps.run(command, args, options);
  assert.throws(() => prepareBaseline({ repository, repo: f.repo, sha: f.old }, { run }), /does not match pinned SHA/);
});

test('invalid inputs reject before any network or git action', () => {
  const deps = { run: () => assert.fail('must reject before subprocess') };
  for (const count of [undefined, 0, -1, '1.5', '1e3', ' 2', '9007199254740992', '--all']) {
    assert.throws(() => pickBaselines({ repository, count }, deps), /count/);
  }
  for (const name of ['-x/repo', 'owner/-x', 'owner/repo/extra', 'owner/repo;echo', 'https://github.com/a/b', 'a/../b', 'a/b\n']) {
    assert.throws(() => pickBaselines({ repository: name, count: 1 }, deps), /repository/);
  }
  for (const ref of ['HEAD', '--upload-pack=x', 'v1x2x3', 'v1.2.3:refs/tags/evil', 'v1.2.3\n', 'v1.2.3-rc1', '']) {
    assert.throws(() => pickBaselines({ repository, count: 1, installRef: ref }, deps), /exact numeric/);
    assert.throws(() => pickBaselines({ repository, count: 1, excludeRef: ref }, deps), /exact numeric/);
  }
  for (const sha of ['HEAD', 'a'.repeat(39), 'a'.repeat(40) + ':refs/tags/x', '']) {
    assert.throws(() => prepareBaseline({ repository, sha }, deps), /40-hex/);
  }
});

test('CLI invalid arguments exit nonzero without JSON output', () => {
  for (const args of [[], ['pick', '--repository', repository, '--count', '0'], ['prepare', '--repository', repository, '--sha', 'HEAD'],
    ['pick', '--repository', repository, '--count', '1', '--unknown', 'x']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /error:/);
  }
});

test('CLI outputs annotations and prepare receipt through a real local Git transport', (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, 'bin');
  mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  writeFileSync(gh, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(JSON.stringify(f.pages)) + ');\n', { mode: 0o755 });
  // Environment-scoped Git URL substitution tests the production CLI without
  // adding a test URL flag or editing any repository/global configuration.
  const env = { ...f.env, PATH: bin + path.delimiter + process.env.PATH,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.' + f.source + '.insteadOf', GIT_CONFIG_VALUE_0: sourceUrl };
  const picked = spawnSync(process.execPath, [cli, 'pick', '--repository', repository, '--count', '1', '--repo', f.repo], { env, encoding: 'utf8' });
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(JSON.parse(picked.stdout), [{ ref: 'v1.0.0', desktop: true, sha: f.newest, repository }]);
  assert.match(picked.stderr, /Excluding.*no-change/);
  const prepared = spawnSync(process.execPath, [cli, 'prepare', '--repository', repository, '--sha', f.newest, '--repo', f.repo], { env, encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), { sha: f.newest, repository });
  assert.equal(f.git(f.repo, 'tag', '--list'), '');
});

// To demonstrate the original regression without treating a missing new module
// as evidence, point RELEASE_BASELINE_LEGACY_PICKER at the base revision's
// pick-release-tags.sh. This same newest-release assertion must fail there.
test('newest published semver supersedes an older calendar release', (t) => {
  const f = fixture(t);
  f.pages.splice(0, f.pages.length, [release('v2026.1.1', 1), release('v1.0.0', 3)]);
  let refs;
  if (process.env.RELEASE_BASELINE_LEGACY_PICKER) {
    f.git(f.repo, 'tag', 'v2026.1.1', f.old);
    f.git(f.repo, 'tag', 'v1.0.0', f.newest);
    refs = JSON.parse(execFileSync('bash', [process.env.RELEASE_BASELINE_LEGACY_PICKER, '--count', '1', '--repo', f.repo], { env: f.env, encoding: 'utf8' }));
  } else {
    refs = pickBaselines({ ...f.options, count: 1 }, f.deps).map((r) => r.ref);
  }
  assert.deepEqual(refs, ['v1.0.0']);
});

test('subprocess errors do not leak captured output', () => {
  assert.throws(() => listPublishedReleases(repository, () => ({ status: 1, stdout: 'credential-value' })), (error) => !error.message.includes('credential-value'));
  assert.throws(() => runCommand('nonexistent-release-baseline-command', []), /failed to execute/);
});
