import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const desktopPaths = /^(apps\/(desktop|desktop-runtime)\/|packages\/(desktop-contracts|theme)\/|scripts\/(desktop|ci)\/|tests\/(desktop|desktop-ui)\/|LICENSES\/desktop\/)/;
const desktopFiles = new Set([
  '.github/workflows/check.yml', '.github/workflows/desktop-package.yml',
  'package.json', 'pnpm-workspace.yaml', '.node-version', 'tsconfig.base.json',
  'playwright.desktop.config.ts', 'THIRD_PARTY_NOTICES.md',
]);

// Compare only the lockfile graph reachable from the desktop workspaces.
export function desktopLockGraph(lock) {
  const graph = { metadata: {}, importers: {}, packages: {}, snapshots: {} };
  for (const [key, value] of Object.entries(lock)) {
    if (!['importers', 'packages', 'snapshots'].includes(key)) graph.metadata[key] = value;
  }
  const importers = ['apps/desktop', 'apps/desktop-runtime', 'packages/desktop-contracts'];
  const snapshots = [];
  const visitDependencies = (dependencies, importer) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      const version = typeof dependency === 'string' ? dependency : dependency.version;
      if (version.startsWith('link:')) {
        importers.push(path.posix.normalize(path.posix.join(importer, version.slice(5))));
      } else {
        snapshots.push(`${name}@${version}`);
      }
    }
  };
  while (importers.length) {
    const importer = importers.shift();
    if (Object.hasOwn(graph.importers, importer)) continue;
    const entry = lock.importers?.[importer];
    if (!entry) throw new Error(`Missing desktop importer: ${importer}`);
    graph.importers[importer] = entry;
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      visitDependencies(entry[kind], importer);
    }
  }
  while (snapshots.length) {
    const key = snapshots.shift();
    if (Object.hasOwn(graph.snapshots, key)) continue;
    const entry = lock.snapshots?.[key];
    if (!entry) throw new Error(`Missing desktop dependency snapshot: ${key}`);
    graph.snapshots[key] = entry;
    const packageKey = key.split('(')[0];
    const metadata = lock.packages?.[packageKey];
    if (!metadata) throw new Error(`Missing desktop dependency metadata: ${packageKey}`);
    graph.packages[packageKey] = metadata;
    visitDependencies(entry.dependencies, '.');
    visitDependencies(entry.optionalDependencies, '.');
  }
  return graph;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function desktopChanged(files, beforeLock, afterLock) {
  if (files.some(file => desktopPaths.test(file) || desktopFiles.has(file))) return true;
  if (!files.includes('pnpm-lock.yaml')) return false;
  return JSON.stringify(canonical(desktopLockGraph(parse(beforeLock)))) !==
    JSON.stringify(canonical(desktopLockGraph(parse(afterLock))));
}

export function changedRange(eventName, event, sha) {
  if (eventName === 'workflow_dispatch') return null;
  if (eventName === 'pull_request') {
    return `${event.pull_request.base.sha}...${event.pull_request.head.sha}`;
  }
  if (eventName === 'push') {
    if (/^0+$/.test(event.before)) return null;
    return `${event.before}..${event.after ?? sha}`;
  }
  throw new Error(`Unsupported CI event: ${eventName}`);
}

function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const range = changedRange(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA);
  let desktop = true;
  if (range) {
    const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const files = git(['diff', '--name-only', '-z', range]).split('\0').filter(Boolean);
    // A PR uses its merge base, excluding changes merely imported from main.
    const [base, head] = range.split(/\.{2,3}/);
    const baseline = range.includes('...') ? git(['merge-base', base, head]).trim() : base;
    try {
      desktop = desktopChanged(files,
        files.includes('pnpm-lock.yaml') ? git(['show', `${baseline}:pnpm-lock.yaml`]) : '',
        files.includes('pnpm-lock.yaml') ? git(['show', `${head}:pnpm-lock.yaml`]) : '');
    } catch (error) {
      // Incomplete/unsupported lock graphs must never silently skip validation.
      console.warn(`Desktop dependency comparison unavailable; running desktop checks: ${error.message}`);
    }
  }
  console.log(`Desktop changes: ${desktop}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `desktop=${desktop}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
