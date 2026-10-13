#!/usr/bin/env node
/** Published stable upstream releases that can genuinely update to this checkout.
 * No local tags are trusted or created. Drivers install the returned immutable sha,
 * not the display ref, and call prepare before constructing their source clone.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_REPO = fileURLToPath(new URL('../..', import.meta.url));
const NAMESPACE = 'refs/remotes/install-baselines';

function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.includes('..')) {
    throw new Error('--repository must be OWNER/REPO');
  }
  return value;
}

function tagName(value) {
  if (typeof value !== 'string' || !TAG.test(value)) throw new Error('ref must be an exact numeric stable release tag');
  return value;
}

function positiveCount(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('--count must be a positive safe integer');
  }
  return Number(value);
}

/** Injectable subprocess boundary; tests retain real Git fetch/ancestry/tree behavior. */
export function runCommand(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  // Do not echo process output: credential helpers and API errors can contain secrets.
  if (result.error || result.signal) throw new Error(command + ' failed to execute or timed out');
  return { status: result.status, stdout: result.stdout };
}

function checked(run, command, args, cwd) {
  const result = run(command, args, { cwd });
  if (result.status !== 0) throw new Error(command + ' failed (exit ' + result.status + ')');
  return result.stdout.trim();
}

/** gh --slurp wraps paginated release arrays in an outer array. */
export function publishedReleases(pages) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('invalid paginated releases response');
  const seen = new Set();
  const releases = [];
  for (const release of pages.flat()) {
    if (!release || typeof release !== 'object' || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || typeof release.tag_name !== 'string') {
      throw new Error('invalid release metadata');
    }
    if (release.draft || release.prerelease || release.published_at == null || !TAG.test(release.tag_name)) continue;
    const published = Date.parse(release.published_at);
    if (!Number.isFinite(published)) throw new Error('invalid release publication time');
    if (seen.has(release.tag_name)) throw new Error('duplicate published release tag');
    seen.add(release.tag_name);
    releases.push({ ref: release.tag_name, published });
  }
  return releases.sort((a, b) => a.published - b.published || a.ref.localeCompare(b.ref));
}

export function listPublishedReleases(repository, run = runCommand) {
  repositoryName(repository);
  const response = checked(run, 'gh', ['api', '--hostname', 'github.com', 'repos/' + repository + '/releases?per_page=100', '--paginate', '--slurp']);
  let pages;
  try { pages = JSON.parse(response); } catch { throw new Error('invalid releases API JSON'); }
  return publishedReleases(pages);
}

/** Preserve oldest/newest endpoints and evenly sample publication chronology. */
export function spread(items, count) {
  count = positiveCount(count);
  if (items.length <= count) return items;
  if (count === 1) return items.slice(-1);
  return Array.from({ length: count }, (_, slot) => items[Math.round(slot * (items.length - 1) / (count - 1))]);
}

function gitContext(repository, repo, run) {
  repositoryName(repository);
  const git = (...args) => checked(run, 'git', args, repo);
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('full checkout history required; shallow checkout cannot prove ancestry');
  const head = git('rev-parse', '--verify', 'HEAD^{commit}');
  if (!SHA.test(head)) throw new Error('HEAD is not a 40-hex commit');
  return { git, head, url: 'https://github.com/' + repository + '.git' };
}

function fetchCommit(context, source, destination) {
  // Explicit refspec + --no-tags avoids contaminating the fork's release tags.
  context.git('fetch', '--no-tags', '--no-recurse-submodules', context.url, '+' + source + ':' + destination);
  const sha = context.git('rev-parse', '--verify', destination + '^{commit}');
  if (!SHA.test(sha)) throw new Error('fetched baseline is not a 40-hex commit');
  return sha;
}

function exclusion(sha, head, repo, run) {
  if (sha === head) return 'same commit as HEAD (no-change transition)';
  const result = run('git', ['merge-base', '--is-ancestor', sha, head], { cwd: repo });
  if (result.status === 0) return null;
  if (result.status === 1) return 'not an ancestor of HEAD (future or diverged release)';
  throw new Error('git ancestry check failed (exit ' + result.status + ')');
}

export function pickBaselines({ repository, count, installRef, excludeRef, repo = DEFAULT_REPO }, { run = runCommand, warn = (message) => console.error(message) } = {}) {
  repositoryName(repository);
  count = positiveCount(count);
  if (installRef !== undefined) tagName(installRef);
  if (excludeRef !== undefined) tagName(excludeRef);
  const releases = listPublishedReleases(repository, run);
  if (installRef && !releases.some((release) => release.ref === installRef)) throw new Error('install-ref is not a published stable release');
  if (installRef && installRef === excludeRef) throw new Error('install-ref is excluded');
  const context = gitContext(repository, repo, run);
  const candidates = installRef ? releases.filter((release) => release.ref === installRef) : releases;
  const refs = [...new Set([...candidates.map((release) => release.ref), ...(excludeRef ? [excludeRef] : [])])];
  if (!refs.length) throw new Error('no compatible published stable baseline is a strict ancestor of HEAD');
  // One transport request for the published stable set keeps selection inside
  // the job budget as release history grows; no local tag refs are touched.
  context.git('fetch', '--no-tags', '--no-recurse-submodules', context.url,
    ...refs.map((ref) => '+refs/tags/' + ref + ':' + NAMESPACE + '/' + ref));
  const resolve = (ref) => {
    const sha = context.git('rev-parse', '--verify', NAMESPACE + '/' + ref + '^{commit}');
    if (!SHA.test(sha)) throw new Error('fetched baseline is not a 40-hex commit');
    return sha;
  };
  // The excluded candidate can be an unpublished candidate tag. Resolve it from
  // the source so aliases of that same commit cannot sneak into the matrix.
  const excludedSha = excludeRef ? resolve(excludeRef) : undefined;
  const eligible = [];
  for (const { ref } of candidates) {
    const sha = resolve(ref);
    const reason = ref === excludeRef || sha === excludedSha ? 'excluded candidate tag or commit' : exclusion(sha, context.head, repo, run);
    if (reason) {
      warn('Excluding ' + ref + ' (' + sha + '): ' + reason);
      if (installRef) throw new Error('install-ref cannot be used: ' + reason);
      continue;
    }
    const tree = context.git('ls-tree', '-d', sha, '--', 'apps/desktop');
    const desktop = /^040000 tree [0-9a-f]{40}\tapps\/desktop$/m.test(tree);
    eligible.push({ ref, desktop, sha, repository });
  }
  if (!eligible.length) throw new Error('no compatible published stable baseline is a strict ancestor of HEAD');
  return spread(eligible, count);
}

/** Materialize the matrix's pin, without trusting mutable tag names again. */
export function prepareBaseline({ repository, sha, repo = DEFAULT_REPO }, { run = runCommand } = {}) {
  repositoryName(repository);
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('--sha must be an exact lowercase 40-hex commit');
  const context = gitContext(repository, repo, run);
  const fetched = fetchCommit(context, sha, NAMESPACE + '/sha-' + sha);
  if (fetched !== sha) throw new Error('fetched commit does not match pinned SHA');
  const reason = exclusion(sha, context.head, repo, run);
  if (reason) throw new Error('pinned baseline cannot be used: ' + reason);
  return { sha, repository };
}

export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command !== 'pick' && command !== 'prepare') throw new Error('expected pick or prepare');
  const options = { repository: { type: 'string' }, repo: { type: 'string' } };
  if (command === 'pick') Object.assign(options, { count: { type: 'string' }, 'install-ref': { type: 'string' }, 'exclude-ref': { type: 'string' } });
  else options.sha = { type: 'string' };
  const { values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false });
  const result = command === 'pick'
    ? pickBaselines({ repository: values.repository, repo: values.repo, count: values.count, installRef: values['install-ref'], excludeRef: values['exclude-ref'] })
    : prepareBaseline({ repository: values.repository, repo: values.repo, sha: values.sha });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error('error: ' + error.message);
    process.exitCode = 1;
  }
}
