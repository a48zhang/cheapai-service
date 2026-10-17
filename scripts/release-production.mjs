import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const worker = ['--filter', '@sub2api/worker', 'exec', 'wrangler'];
const production = ['--config', 'wrangler.jsonc', '--env', 'production'];

function run(args) {
  console.log(`\n> pnpm ${args.join(' ')}`);
  const result = spawnSync('pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['run', 'build:cloud']);
if (dryRun) {
  console.log(
    '\nDry run: remote D1 migrations, Worker publication and live health verification are skipped.',
  );
  run([
    ...worker,
    'deploy',
    ...production,
    '--dry-run',
    '--outdir',
    '../../.wrangler/release-production-dry-run',
  ]);
} else {
  run([...worker, 'd1', 'migrations', 'apply', 'DB', ...production, '--remote']);
  run([...worker, 'deploy', ...production]);
  const url = 'https://cheapai.dev/healthz';
  console.log(`\n> GET ${url}`);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok || (await response.json()).status !== 'ok') {
    throw new Error(
      `Production health verification failed (HTTP ${response.status}). Deployment is not rolled back automatically.`,
    );
  }
  console.log(
    'Production /healthz passed. Database, authentication, email and upstream behavior require the documented release verification.',
  );
}
