import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import yaml from 'js-yaml';

// Execute runner selection from workflow configuration, not script source text.
const caller = yaml.load(readFileSync(new URL('../.github/workflows/install-e2e.yml', import.meta.url), 'utf8'));
const windows = yaml.load(readFileSync(new URL('../.github/workflows/install-e2e-windows-run.yml', import.meta.url), 'utf8'));
function value(setting, context) {
  if (typeof setting !== 'string' || !setting.startsWith('$' + '{{')) return setting;
  const expression = setting.slice(3, -2).trim().replace(/inputs[.]([A-Za-z0-9_-]+)/g, 'inputs["$1"]');
  return runInNewContext(expression, { ...context, startsWith: (s, prefix) => s.startsWith(prefix) });
}
function sourceRunner(repository, release, installMethod) {
  const context = { github: { repository }, inputs: { release }, matrix: { install_method: installMethod } };
  const runner = value(caller.jobs.windows.with['source-runner'], context)
    ?? windows.on.workflow_call.inputs['source-runner']?.default;
  return value(windows.jobs.e2e['runs-on'], { inputs: { 'source-runner': runner } });
}
test('tracking fork script installs use standard Windows runners, including HEAD and stable baselines', () => {
  for (const method of ['installer-script', 'installer-script+desktop']) {
    assert.equal(sourceRunner('teamauresta/hermes-agent', false, method), 'windows-latest');
  }
});
test('upstream, unrelated forks, release-mode and published desktop installer retain larger source runners', () => {
  for (const [repository, release, method] of [
    ['NousResearch/hermes-agent', false, 'installer-script'],
    ['example/fork', false, 'installer-script'],
    ['teamauresta/hermes-agent', true, 'installer-script'],
    ['teamauresta/hermes-agent', false, 'desktop-installer@latest'],
  ]) assert.equal(sourceRunner(repository, release, method), 'windows-latest-32-core');
});
test('bundled x64 and arm64 runner selection remains independent of source-runner override', () => {
  for (const [arch, expected] of [['x64', 'windows-latest-32-core'], ['arm64', 'windows-latest-32-arm-core']]) {
    assert.equal(value(windows.jobs['bundled-e2e']['runs-on'], {
      inputs: { 'bundle-arch': arch, 'source-runner': 'windows-latest' },
    }), expected);
  }
});
