import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.PR_PREVIEW_SOURCE_ROOT
  ? resolve(process.env.PR_PREVIEW_SOURCE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function previewName(repository, number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !/^[1-9][0-9]{0,9}$/.test(String(number))) {
    throw new Error('Expected a repository owner/name and positive PR number.');
  }
  return `sub2api-${createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 10)}-pr-${number}`;
}
export function previewConfig({ repository, number, account, subdomain, backend }) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]*$/.test(subdomain)
    || !/^[a-f0-9-]{36}$/.test(backend.database.id) || !/^[a-f0-9]{32}$/.test(backend.cache.id)
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(backend.gate.script)) throw new Error('Invalid Cloudflare resource identifiers.');
  const name = previewName(repository, number);
  return {
    name, account_id: account, main: resolve(root, 'apps/worker/index.ts'),
    compatibility_date: '2026-08-15', workers_dev: true, preview_urls: false,
    vars: { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: `https://${name}.${subdomain}.workers.dev`, EMAIL_VERIFICATION_READY: 'false' },
    // Branch code shares preview storage; no schedules or outgoing mail.
    triggers: { crons: [] }, send_email: [],
    assets: { directory: resolve(root, 'apps/web/dist'), binding: 'ASSETS', not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*', '/v1', '/v1/*', '/healthz'] },
    d1_databases: [{ binding: 'DB', database_name: backend.database.name, database_id: backend.database.id, migrations_dir: resolve(root, 'migrations') }],
    kv_namespaces: [{ binding: 'CACHE', id: backend.cache.id }],
    durable_objects: { bindings: [{ name: 'GATE', class_name: 'Gate', script_name: backend.gate.script }] },
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
export function cloudflareApi(account, token, fetcher = fetch) {
  if (!token || !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; never commit credentials.');
  return async (path, method = 'GET', body, allowMissing = false) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
    });
    if (allowMissing && response.status === 404) return null;
    const data = await response.json();
    // Never echo request payloads, tokens, or arbitrary service error messages.
    if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}).`);
    return data;
  };
}
export async function existingPreviewBackend(api) {
  // Resolve the fixed shared environment by name; no CI variable or override.
  const worker = 'cheapai-preview';
  const settings = await api(`workers/scripts/${worker}/settings`, 'GET', undefined, true);
  if (!settings) throw new Error('Shared Worker cheapai-preview does not exist. Provision it separately; PR CI never creates shared resources.');
  const bindings = settings.result?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Invalid preview backend settings.');
  const binding = (name, type) => {
    const matches = bindings?.filter(item => item.name === name) ?? [];
    if (matches.length !== 1 || matches[0].type !== type) throw new Error(`Preview backend requires exactly one ${name} binding of type ${type}.`);
    return matches[0];
  };
  if (binding('ENVIRONMENT', 'plain_text').text !== 'staging') throw new Error('Preview backend must have ENVIRONMENT=staging.');
  const db = binding('DB', 'd1');
  const cache = binding('CACHE', 'kv_namespace');
  const gate = binding('GATE', 'durable_object_namespace');
  const gateScript = gate.script_name || worker;
  if (!/^[a-f0-9-]{36}$/.test(db.id || '') || !/^[a-f0-9]{32}$/.test(cache.namespace_id || '')
    || !/^[a-f0-9]{32}$/.test(gate.namespace_id || '') || gate.class_name !== 'Gate'
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(gateScript) || gateScript.endsWith('-production')) {
    throw new Error('Preview backend has invalid DB/CACHE/GATE bindings.');
  }
  const production = await api('workers/scripts/sub2api-cloudflare-production/settings', 'GET', undefined, true);
  for (const item of production?.result?.bindings ?? []) {
    if ((item.type === 'd1' && item.id === db.id)
      || (item.type === 'kv_namespace' && item.namespace_id === cache.namespace_id)
      || (item.type === 'durable_object_namespace' && item.namespace_id === gate.namespace_id)) {
      throw new Error('Preview backend references production storage; refusing deployment.');
    }
  }
  const database = (await api(`d1/database/${db.id}`)).result;
  const kv = await findResource(api, 'storage/kv/namespaces', 'id', cache.namespace_id);
  const namespace = await findResource(api, 'workers/durable_objects/namespaces', 'id', gate.namespace_id);
  if (database?.uuid !== db.id || !database.name || database.name.endsWith('-production') || !kv
    || namespace?.script !== gateScript || namespace?.class !== 'Gate') {
    throw new Error('Preview DB/CACHE/GATE resources are missing or inconsistent. Provision them separately; PR CI never creates them.');
  }
  return { worker, database: { id: db.id, name: database.name }, cache: { id: cache.namespace_id },
    gate: { script: gateScript, id: gate.namespace_id } };
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
export async function main() {
  const repository = process.env.GITHUB_REPOSITORY || 'a48zhang/cheapai-service';
  const number = process.env.PR_NUMBER;
  const name = previewName(repository, number);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const api = cloudflareApi(account, process.env.CLOUDFLARE_API_TOKEN);
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
      await summary(`PR #${number} closed: ${name} public preview disabled. The existing shared preview backend is unchanged. No automatic backup or deletion.`);
      return;
    }
    if (process.env.PR_EVENT_ACTION === 'closed' || pr.state !== 'open' || pr.head.sha !== process.env.PR_HEAD_SHA) {
      await summary(`Skipped outdated run for PR #${number}; the latest head owns the preview.`);
      return;
    }
  }
  const backend = await existingPreviewBackend(api);
  const subdomain = (await api('workers/subdomain')).result?.subdomain;
  if (!subdomain) throw new Error('Enable a workers.dev subdomain in the Cloudflare dashboard first.');
  const config = previewConfig({ repository, number, account, subdomain, backend });
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
  await summary(`PR #${number}: ${url}\n\nHead: ${process.env.PR_HEAD_SHA}\n\nBranch Worker: ${name}; existing preview backend: ${backend.worker}; D1: ${backend.database.name}; Gate host: ${backend.gate.script}. Shared resources are not created or redeployed. Email and cron are disabled. Initialize the shared administrator once following docs/pr-previews.md. This smoke check covers HTML and liveness, not authenticated flows or live models.`);
  if (!healthy) throw new Error('Preview deployed, but HTTP smoke check did not pass. Inspect the URL and rerun after resolving the failure.');
}
async function selfTest() {
  const repository = 'a48zhang/cheapai-service';
  const name = previewName(repository, '1');
  assert.match(name, /^sub2api-[a-f0-9]{10}-pr-1$/);
  assert.notEqual(name, previewName(repository, '2'));
  assert.notEqual(name, previewName('other/repository', '1'));
  for (const value of ['0', '../1', '1;echo', undefined]) assert.throws(() => previewName('a/b', value));
  assert.throws(() => previewName('../bad', '1'));
  const shared = 'cheapai-preview';
  const db = '00000000-0000-0000-0000-000000000001';
  const kv = 'b'.repeat(32);
  const gate = 'c'.repeat(32);
  const fixtures = {
    [`workers/scripts/${shared}/settings`]: { result: { bindings: [
      { name: 'ENVIRONMENT', type: 'plain_text', text: 'staging' },
      { name: 'DB', type: 'd1', id: db },
      { name: 'CACHE', type: 'kv_namespace', namespace_id: kv },
      { name: 'GATE', type: 'durable_object_namespace', namespace_id: gate, class_name: 'Gate' },
    ] } },
    'workers/scripts/sub2api-cloudflare-production/settings': { result: { bindings: [
      { type: 'd1', id: '00000000-0000-0000-0000-000000000002' },
      { type: 'kv_namespace', namespace_id: 'd'.repeat(32) },
      { type: 'durable_object_namespace', namespace_id: 'e'.repeat(32) },
    ] } },
    [`d1/database/${db}`]: { result: { uuid: db, name: 'shared-preview-db' } },
    'storage/kv/namespaces': { result: [{ id: kv, title: 'shared-preview-cache' }] },
    'workers/durable_objects/namespaces': { result: [{ id: gate, script: shared, class: 'Gate' }] },
  };
  const api = (data) => async (path, method = 'GET') => {
    assert.equal(method, 'GET', 'Existing backend resolution must never create or update resources.');
    const key = path.split('?')[0];
    assert.ok(Object.hasOwn(data, key), `Unexpected API request: ${key}`);
    return structuredClone(data[key]);
  };
  const backend = await existingPreviewBackend(api(fixtures));
  const config = previewConfig({ repository, number: '1', account: 'a'.repeat(32), subdomain: 'test', backend });
  assert.equal(config.d1_databases[0].database_name, 'shared-preview-db');
  assert.equal(config.vars.PUBLIC_BASE_URL, `https://${name}.test.workers.dev`);
  assert.deepEqual(config.send_email, []);
  assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.preview_urls, false);
  assert.equal(config.env, undefined);
  assert.equal(config.migrations, undefined, 'Branch Workers must not create a DO namespace.');
  const other = previewConfig({ repository: 'other/renamed-repository', number: '2', account: 'a'.repeat(32), subdomain: 'test', backend });
  for (const key of ['d1_databases', 'kv_namespaces', 'durable_objects']) assert.deepEqual(config[key], other[key]);
  const rejectFixture = async (change, expected) => {
    const data = structuredClone(fixtures);
    change(data);
    await assert.rejects(existingPreviewBackend(api(data)), expected);
  };
  await rejectFixture(data => { data[`workers/scripts/${shared}/settings`] = null; }, /does not exist/);
  await rejectFixture(data => { data['storage/kv/namespaces'].result = []; }, /resources are missing/);
  await rejectFixture(data => { data['workers/durable_objects/namespaces'].result = []; }, /resources are missing/);
  await rejectFixture(data => { data[`d1/database/${db}`].result = null; }, /resources are missing/);
  await rejectFixture(data => { data[`workers/scripts/${shared}/settings`].result.bindings[0].text = 'production'; }, /ENVIRONMENT=staging/);
  for (let i = 0; i < 3; i++) {
    await rejectFixture(data => {
      const production = data['workers/scripts/sub2api-cloudflare-production/settings'].result.bindings[i];
      if (i === 0) production.id = db;
      else production.namespace_id = i === 1 ? kv : gate;
    }, /production storage/);
  }
  const external = structuredClone(fixtures);
  external[`workers/scripts/${shared}/settings`].result.bindings[3].script_name = 'existing-preview-gate';
  external['workers/durable_objects/namespaces'].result[0].script = 'existing-preview-gate';
  assert.equal((await existingPreviewBackend(api(external))).gate.script, 'existing-preview-gate');
  let requests = 0;
  const resource = await findResource(async () => ({ result: ++requests === 1 ? Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })) : [{ name: shared, uuid: 'chosen' }] }), 'd1/database', 'name', shared);
  assert.equal(requests, 2); assert.equal(resource.uuid, 'chosen');
  await assert.rejects(findResource(async () => ({ result: [{ name: shared }, { name: shared }] }), 'd1/database', 'name', shared));
  assert.equal(await findResource(async () => ({ result: [] }), 'd1/database', 'name', shared), undefined);
  console.log('PR preview self-test passed (existing backend, read-only discovery, missing resources, production isolation, repository rename, pagination).');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--self-test') ? selfTest() : main()).catch(error => { console.error(error.message); process.exitCode = 1; });
}
