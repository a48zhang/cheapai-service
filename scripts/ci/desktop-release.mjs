import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseTargets = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
];

/** Stage complete, commit-matched installers with unique names across platforms. */
export async function prepareReleaseAssets(input, output, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('A full source commit is required.');
  const assets = [];
  for (const target of releaseTargets) {
    const root = join(input, `desktop-installer-${target}-${commit}`);
    const files = await readdir(root, { recursive: true });
    const extension = target.endsWith('darwin') ? '.dmg' : '.exe';
    const installers = files.filter((file) => file.endsWith(extension));
    const manifests = files.filter((file) => basename(file) === 'release-manifest.json');
    if (installers.length !== 1 || manifests.length !== 1) {
      throw new Error(`Expected one installer and one release manifest for ${target}.`);
    }
    const manifest = JSON.parse(await readFile(join(root, manifests[0]), 'utf8'));
    if (manifest.source?.commit !== commit || manifest.target?.triple !== target) {
      throw new Error(`Release manifest source or target does not match ${target}.`);
    }
    assets.push(
      { source: join(root, installers[0]), name: `cheapai-desktop-${target}${extension}` },
      { source: join(root, manifests[0]), name: `release-manifest-${target}.json` },
    );
  }
  await mkdir(output, { recursive: true });
  for (const asset of assets) await copyFile(asset.source, join(output, asset.name));
  return assets.map((asset) => asset.name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error('Usage: desktop-release.mjs <artifacts> <release-assets>');
  await prepareReleaseAssets(input, output, process.env.GITHUB_SHA);
}
