import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hashPassword } from '../apps/worker/auth/password.ts';
import { buildBootstrapSql } from './bootstrap-admin.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).engines.node;
if (process.versions.node !== expected) throw new Error(`Use Node ${expected} to start local browser tests.`);
const portText = process.env.SUB2API_E2E_PORT ?? '9789';
if (!/^[0-9]{4,5}$/.test(portText) || Number(portText) > 65535 || Number(portText) < 1024) throw new Error('Invalid local test port.');
const baseURL = `https://127.0.0.1:${portText}`;
const parent = join(root, '.wrangler', 'e2e');
const work = join(parent, `run-${randomUUID()}`);
await mkdir(work, { recursive: true });
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(work, 'wrangler.log') };
delete environment.CLOUDFLARE_ENV;
function run(args, cwd = root) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { if (output.length < 250_000) output += chunk.toString(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', reject);
    child.on('exit', async code => {
      if (code === 0) accept(output);
      else { await writeFile(join(work, 'setup-error.log'), output); reject(new Error(`Local setup failed (exit ${code}); see .wrangler/e2e logs.`)); }
    });
  });
}
const web = join(root, 'apps/web');
await run([join(web, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--project', join(web, 'tsconfig.json'), '--noEmit']);
await run([join(web, 'node_modules/vite/bin/vite.js'), 'build'], web);
const source = ts.parseConfigFileTextToJson('wrangler.jsonc', await readFile(join(root, 'apps/worker/wrangler.jsonc'), 'utf8'));
if (source.error) throw new Error('Could not parse local Wrangler configuration.');
const config = source.config;
delete config.env; delete config.triggers; delete config.send_email; delete config.$schema;
config.name = 'sub2api-local-e2e';
config.main = join(root, 'tests/helpers/http-test-worker.ts');
config.workers_dev = false; config.preview_urls = false;
config.assets.directory = join(web, 'dist');
config.assets.run_worker_first = [...config.assets.run_worker_first, '/__test__/*'];
config.d1_databases = [{ binding: 'DB', database_name: 'sub2api-local-e2e', database_id: '00000000-0000-0000-0000-000000000099', migrations_dir: join(root, 'migrations'), remote: false }];
config.kv_namespaces = [{ binding: 'CACHE', id: '00000000000000000000000000000099', remote: false }];
const token = randomBytes(32).toString('hex');
config.vars = { ENVIRONMENT: 'local', PUBLIC_BASE_URL: baseURL, EMAIL_VERIFICATION_READY: 'true', EMAIL_FROM: 'e2e-sender@example.invalid',
  EMAIL_HMAC_KEY: randomBytes(32).toString('base64'), CHANNEL_ACTIVE_KEY_VERSION: 'e2e',
  CHANNEL_KEYRING_JSON: JSON.stringify({ e2e: randomBytes(32).toString('base64') }), E2E_CONTROL_TOKEN: token };
const configPath = join(work, 'wrangler.json');
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
// A local file next to this generated config prevents inheriting an unrelated
// developer secret file and keeps fixture credentials hidden in dev summaries.
// dotenv does not JSON-unescape inner quotes. Single quoting preserves the
// keyring JSON exactly; all generated fixture values are single-line strings.
if (Object.values(config.vars).some(value => typeof value !== 'string' || /['\r\n]/.test(value))) throw new Error('Unexpected local fixture variable.');
await writeFile(join(work, '.dev.vars'), Object.entries(config.vars).map(([key, value]) => `${key}='${value}'`).join('\n'), { mode: 0o600 });
const wrangler = join(root, 'apps/worker/node_modules/wrangler/bin/wrangler.js');
const common = ['--config', configPath, '--local', '--persist-to', join(work, 'state')];
await run([wrangler, 'd1', 'migrations', 'apply', 'DB', ...common]);
// These credentials exist only in this new local database, never a real account.
const adminEmail = 'e2e-admin@example.invalid'; const adminPassword = 'local-browser-fixture-password';
const hash = await hashPassword(adminPassword);
const sqlPath = join(work, 'bootstrap.sql');
await writeFile(sqlPath, buildBootstrapSql(adminEmail, hash, randomUUID(), Date.now()), { mode: 0o600 });
await run([wrangler, 'd1', 'execute', 'DB', '--file', sqlPath, '--json', ...common]);
const connection = JSON.stringify({ baseURL, token, adminEmail, adminPassword, work });
await writeFile(join(parent, `connection-${portText}.json`), connection, { mode: 0o600 });
if (portText === '9789') await writeFile(join(parent, 'connection.json'), connection, { mode: 0o600 });
console.log(`Starting isolated local browser-test Worker at ${baseURL}`);
const server = spawn(process.execPath, [wrangler, 'dev', ...common, '--ip', '127.0.0.1', '--port', portText, '--local-protocol', 'https'],
  { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  if (server.exitCode !== null) return;
  if (process.platform === 'win32' && server.pid) {
    spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else server.kill('SIGTERM');
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
server.once('error', error => { console.error(error.message); process.exitCode = 1; });
server.once('exit', code => { process.exitCode = stopping ? 0 : code ?? 1; });
