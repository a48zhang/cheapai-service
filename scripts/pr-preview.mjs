import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function previewName(repository, number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !/^[1-9][0-9]{0,9}$/.test(String(number))) {
    throw new Error('Expected a repository owner/name and positive PR number.');
  }
  return `sub2api-${createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 10)}-pr-${number}`;
}
export function previewConfig({ repository, number, account, subdomain, database, namespace }) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]*$/.test(subdomain)
    || !/^[a-f0-9-]{36}$/.test(database) || !/^[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid Cloudflare resource identifiers.');
  const name = previewName(repository, number);
  return {
    name, account_id: account, main: resolve(root, 'apps/worker/index.ts'),
    compatibility_date: '2026-08-15', workers_dev: true, preview_urls: false,
    vars: { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: `https://${name}.${subdomain}.workers.dev`, EMAIL_VERIFICATION_READY: 'false' },
    // No schedules or outgoing mail in disposable PR environments.
    triggers: { crons: [] }, send_email: [],
    assets: { directory: resolve(root, 'apps/web/dist'), binding: 'ASSETS', not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*', '/v1', '/v1/*', '/healthz'] },
    d1_databases: [{ binding: 'DB', database_name: name, database_id: database, migrations_dir: resolve(root, 'migrations') }],
    kv_namespaces: [{ binding: 'CACHE', id: namespace }],
    durable_objects: { bindings: [{ name: 'GATE', class_name: 'Gate' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Gate'] }],
  };
}
export async function findResource(api, path, field, name) {
  for (let page = 1; ; page++) {
    const data = await api(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(data.result)) throw new Error('Invalid resource list response.');
    const matches = data.result.filter(item => item[field] === name);
    if (matches.length > 1) throw new Error('Ambiguous resource name; refusing to select one.');
    if (matches.length) return matches[0];
    if (data.result.length < 100) return undefined;
  }
}
async function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
function wrangler(args) {
  const cli = resolve(root, 'apps/worker/node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`Wrangler ${args[0]} failed; resources are retained for retry.`);
}
async function main() {
  const repository = process.env.GITHUB_REPOSITORY || 'a48zhang/sub2api-cloudflare';
  const number = process.env.PR_NUMBER;
  const name = previewName(repository, number);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token || !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; never commit credentials.');
  const api = async (path, method = 'GET', body, allowMissing = false) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
    });
    if (allowMissing && response.status === 404) return null;
    const data = await response.json();
    // Never echo request payloads, tokens, or arbitrary service error messages.
    if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}).`);
    return data;
  };
  const configOnly = process.argv.includes('--config-only');
  if (!configOnly) {
    if (!process.env.GITHUB_TOKEN || !/^[a-f0-9]{40}$/.test(process.env.PR_HEAD_SHA || '')) throw new Error('CI requires GITHUB_TOKEN and PR_HEAD_SHA. Use --config-only for local configuration.');
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot verify current PR state (HTTP ${response.status}).`);
    const pr = await response.json();
    if (pr.head?.repo?.full_name !== repository) throw new Error('Fork previews are not allowed.');
    if (pr.state === 'closed') {
      const existing = await api(`workers/scripts/${name}/subdomain`, 'GET', undefined, true);
      if (existing) await api(`workers/scripts/${name}/subdomain`, 'POST', { enabled: false, previews_enabled: false });
      await summary(`PR #${number} closed: ${name} public preview disabled. D1, KV and Durable Object data are retained; no automatic backup or deletion. Remove these exact PR-owned resources manually when no longer needed.`);
      return;
    }
    if (process.env.PR_EVENT_ACTION === 'closed' || pr.state !== 'open' || pr.head.sha !== process.env.PR_HEAD_SHA) {
      await summary(`Skipped outdated run for PR #${number}; the latest head owns the preview.`);
      return;
    }
  }
  const subdomain = (await api('workers/subdomain')).result?.subdomain;
  if (!subdomain) throw new Error('Enable a workers.dev subdomain in the Cloudflare dashboard first.');
  let db = await findResource(api, 'd1/database', 'name', name);
  let kv = await findResource(api, 'storage/kv/namespaces', 'title', name);
  if (configOnly && (!db || !kv)) throw new Error('Preview resources do not exist yet; deploy the PR first.');
  if (!db) db = (await api('d1/database', 'POST', { name })).result;
  if (!kv) kv = (await api('storage/kv/namespaces', 'POST', { title: name })).result;
  const config = previewConfig({ repository, number, account, subdomain, database: db.uuid, namespace: kv.id });
  const filename = resolve(root, `.wrangler/pr-preview-${number}.json`);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (configOnly) { console.log(`Preview config: ${filename}`); return; }
  wrangler(['deploy', '--config', filename, '--dry-run', '--strict', '--outdir', resolve(root, '.wrangler/pr-preview-build')]);
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', filename]);
  wrangler(['deploy', '--config', filename, '--strict']);
  // workers.dev routing may take a short time to propagate after first deployment.
  const url = config.vars.PUBLIC_BASE_URL;
  let healthy = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      const home = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok && body.status === 'ok' && home.ok && home.headers.get('content-type')?.includes('text/html')) { healthy = true; break; }
    } catch { /* Bounded retry for routing propagation; no deployment retry. */ }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  await summary(`PR #${number}: ${url}\n\nHead: ${process.env.PR_HEAD_SHA}\n\nIsolated Worker/D1/KV/DO: ${name}. Email and cron are disabled. Initialize an administrator and preview-only channel secrets following docs/pr-previews.md. This smoke check covers HTML and liveness, not authenticated flows or live models.`);
  if (!healthy) throw new Error('Preview deployed, but HTTP smoke check did not pass. Inspect the URL and rerun after resolving the failure.');
}
async function selfTest() {
  const name = previewName('a48zhang/sub2api-cloudflare', '1');
  assert.match(name, /^sub2api-[a-f0-9]{10}-pr-1$/);
  assert.notEqual(name, previewName('a48zhang/sub2api-cloudflare', '2'));
  assert.notEqual(name, previewName('other/repository', '1'));
  for (const value of ['0', '../1', '1;echo', undefined]) assert.throws(() => previewName('a/b', value));
  assert.throws(() => previewName('../bad', '1'));
  const config = previewConfig({ repository: 'a48zhang/sub2api-cloudflare', number: '1', account: 'a'.repeat(32), subdomain: 'test', database: '00000000-0000-0000-0000-000000000001', namespace: 'b'.repeat(32) });
  assert.equal(config.d1_databases[0].database_name, name);
  assert.equal(config.vars.PUBLIC_BASE_URL, `https://${name}.test.workers.dev`);
  assert.deepEqual(config.send_email, []);
  assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.preview_urls, false);
  assert.equal(config.env, undefined);
  let requests = 0;
  const resource = await findResource(async () => ({ result: ++requests === 1 ? Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })) : [{ name, uuid: 'chosen' }] }), 'd1/database', 'name', name);
  assert.equal(requests, 2); assert.equal(resource.uuid, 'chosen');
  await assert.rejects(findResource(async () => ({ result: [{ name }, { name }] }), 'd1/database', 'name', name));
  assert.equal(await findResource(async () => ({ result: [] }), 'd1/database', 'name', name), undefined);
  console.log('PR preview self-test passed (naming, isolation, validation, pagination, ambiguous/missing resources).');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--self-test') ? selfTest() : main()).catch(error => { console.error(error.message); process.exitCode = 1; });
}
