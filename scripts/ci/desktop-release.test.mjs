import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareReleaseAssets, releaseTargets } from './desktop-release.mjs';

const commit = 'a'.repeat(40);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'artifacts');
  const output = join(root, 'release');
  const artifacts = [];
  for (const target of releaseTargets) {
    const folder = join(input, `desktop-installer-${target}-${commit}`, 'nested');
    await mkdir(folder, { recursive: true });
    const installer = join(folder, target.endsWith('darwin') ? 'cheapai.dev.dmg' : 'cheapai.dev.exe');
    const manifest = join(folder, 'release-manifest.json');
    await writeFile(installer, target);
    await writeFile(manifest, JSON.stringify({ source: { commit }, target: { triple: target } }));
    artifacts.push({ folder, installer, manifest });
  }
  return { input, output, artifacts };
}

test('stages all platforms without colliding names and supports retrying the same commit', async (t) => {
  const { input, output } = await fixture(t);
  const names = await prepareReleaseAssets(input, output, commit);
  assert.equal(new Set(names).size, 6);
  for (const target of releaseTargets) {
    const suffix = target.endsWith('darwin') ? '.dmg' : '.exe';
    assert.equal(await readFile(join(output, `cheapai-desktop-${target}${suffix}`), 'utf8'), target);
    const manifest = JSON.parse(await readFile(join(output, `release-manifest-${target}.json`), 'utf8'));
    assert.equal(manifest.source.commit, commit);
    assert.equal(manifest.target.triple, target);
  }
  assert.deepEqual(await prepareReleaseAssets(input, output, commit), names);
  assert.equal((await readdir(output)).length, 6);
});

test('does not stage a partial release if a platform installer is missing or ambiguous', async (t) => {
  for (const mode of ['missing', 'duplicate']) {
    const { input, output, artifacts } = await fixture(t);
    const platform = artifacts[2];
    if (mode === 'missing') await rm(platform.installer);
    else await writeFile(join(platform.folder, 'another.exe'), 'duplicate');
    await assert.rejects(prepareReleaseAssets(input, output, commit), /Expected one installer/);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
  }
});

test('rejects an absent platform artifact and a missing manifest before staging', async (t) => {
  for (const missing of ['folder', 'manifest']) {
    const { input, output, artifacts } = await fixture(t);
    await rm(artifacts[2][missing], { recursive: true });
    await assert.rejects(prepareReleaseAssets(input, output, commit));
    await assert.rejects(readdir(output), { code: 'ENOENT' });
  }
});

test('rejects artifacts built for a different commit or target', async (t) => {
  for (const mismatch of ['commit', 'target']) {
    const { input, output, artifacts } = await fixture(t);
    await writeFile(artifacts[2].manifest, JSON.stringify({
      source: { commit: mismatch === 'commit' ? 'b'.repeat(40) : commit },
      target: { triple: mismatch === 'target' ? releaseTargets[0] : releaseTargets[2] },
    }));
    await assert.rejects(prepareReleaseAssets(input, output, commit), /source or target/);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
  }
});
