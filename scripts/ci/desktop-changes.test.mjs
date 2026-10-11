import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { changedRange, desktopChanged } from './desktop-changes.mjs';

function lock() {
  return {
    lockfileVersion: '9.0',
    importers: {
      'apps/desktop': { dependencies: {
        react: { specifier: '1.0.0', version: '1.0.0' },
        '@cheapai/theme': { specifier: 'workspace:*', version: 'link:../../packages/theme' },
      } },
      'apps/desktop-runtime': {},
      'packages/desktop-contracts': {},
      'packages/theme': {},
      'apps/worker': {},
    },
    packages: { 'react@1.0.0': { resolution: { integrity: 'react' } },
      'helper@1.0.0': { resolution: { integrity: 'helper' } } },
    snapshots: { 'react@1.0.0': { dependencies: { helper: '1.0.0' } }, 'helper@1.0.0': {} },
  };
}

test('web, Worker and documentation changes skip desktop work', () => {
  assert.equal(desktopChanged(['apps/web/src/app.tsx', 'apps/worker/app.ts', 'docs/guide.md']), false);
});

test('desktop source, theme, tooling and UI tests require desktop work', () => {
  for (const file of ['apps/desktop/src/App.tsx', 'apps/desktop-runtime/src/index.ts',
    'packages/desktop-contracts/src/index.ts', 'packages/theme/src/tokens.css',
    'scripts/desktop/dev-desktop.mjs', 'tests/desktop-ui/appearance.spec.ts',
    '.github/workflows/desktop-package.yml', 'tsconfig.base.json']) {
    assert.equal(desktopChanged([file]), true, file);
  }
});

test('Worker-only importer and unrelated packages do not rebuild desktop', () => {
  const after = lock();
  after.importers['apps/worker'].dependencies = { worker: { specifier: '1.0.0', version: '1.0.0' } };
  after.packages['worker@1.0.0'] = { resolution: { integrity: 'worker' } };
  after.snapshots['worker@1.0.0'] = {};
  assert.equal(desktopChanged(['pnpm-lock.yaml'], stringify(lock()), stringify(after)), false);
});

test('transitive desktop dependency metadata changes require desktop work', () => {
  const after = lock();
  after.packages['helper@1.0.0'].resolution.integrity = 'changed';
  assert.equal(desktopChanged(['pnpm-lock.yaml'], stringify(lock()), stringify(after)), true);
});

test('workspace-linked theme dependencies require desktop work', () => {
  const after = lock();
  after.importers['packages/theme'].dependencies = { helper: { specifier: '1.0.0', version: '1.0.0' } };
  assert.equal(desktopChanged(['pnpm-lock.yaml'], stringify(lock()), stringify(after)), true);
});

test('peer-qualified snapshots and optional dependencies are included', () => {
  const before = lock();
  before.importers['apps/desktop'].dependencies.react.version = '1.0.0(helper@1.0.0)';
  before.snapshots['react@1.0.0(helper@1.0.0)'] = { optionalDependencies: { helper: '1.0.0' } };
  const after = structuredClone(before);
  after.snapshots['helper@1.0.0'] = { optional: true };
  assert.equal(desktopChanged(['pnpm-lock.yaml'], stringify(before), stringify(after)), true);
});

test('unsupported graphs throw rather than silently skip desktop work', () => {
  const after = lock();
  delete after.snapshots['helper@1.0.0'];
  assert.throws(() => desktopChanged(['pnpm-lock.yaml'], stringify(lock()), stringify(after)), /Missing desktop dependency/);
});

test('PR ranges use the merge base, pushes use before/after, manual builds always run', () => {
  assert.equal(changedRange('pull_request', { pull_request: { base: { sha: 'base' }, head: { sha: 'head' } } }), 'base...head');
  assert.equal(changedRange('push', { before: 'before', after: 'after' }), 'before..after');
  assert.equal(changedRange('push', { before: '0'.repeat(40), after: 'after' }), null);
  assert.equal(changedRange('workflow_dispatch', {}), null);
});
