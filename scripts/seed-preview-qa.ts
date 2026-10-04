import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEmail } from '../apps/worker/auth/email-proof.ts';
import { hashPassword } from '../apps/worker/auth/password.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'scripts/preview-qa-fixture.json');
const configPath = join(root, '.wrangler/pr-preview-5.json');
const credentialPath = join(root, '.wrangler/qa-preview-credentials.enc.json');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const databaseUuidPattern = uuidPattern;
const accountIdPattern = /^[a-f0-9]{32}$/;

type JsonRecord = Record<string, unknown>;
type Target = {
  accountId: string;
  workerName: string;
  databaseName: string;
  databaseId: string;
  namespaceId: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
}

function buildSelectSql(email: string): string {
  return `SELECT id, role, status FROM users WHERE email_normalized = ${sqlText(email)};\n`;
}

function buildInsertSql(email: string, passwordHash: string, id: string, now: number): string {
  if (normalizeEmail(email) !== email || !uuidPattern.test(id)
    || !/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(passwordHash)
    || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid PR #5 QA seed values.');
  }
  return `INSERT INTO users
    (id,email_normalized,password_hash,role,status,email_verified_at,group_id,balance_units,
     concurrency_limit,rpm_limit,created_via,registration_code_id,created_at,updated_at)
    SELECT ${sqlText(id)},${sqlText(email)},${sqlText(passwordHash)},'admin','active',NULL,g.id,0,
      5,30,'bootstrap',NULL,${now},${now}
    FROM settings s JOIN groups g ON g.id=json_extract(s.value_json,'$')
    WHERE s.key='default_group_id' AND json_type(s.value_json)='text' AND g.status='active'
      AND NOT EXISTS (SELECT 1 FROM users WHERE email_normalized=${sqlText(email)})
    RETURNING id,role,status,CAST(balance_units AS TEXT) AS balance_units;\n`;
}

async function readJsonRecord(filename: string, label: string): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or is not valid JSON.`);
  }
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object.`);
  return value;
}

async function validateTarget(): Promise<{ fixture: JsonRecord; target: Target; email: string }> {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('PR #5 QA seeding is allowed only in GitHub Actions CI.');
  }
  const fixture = await readJsonRecord(fixturePath, 'QA fixture');
  const admin = isRecord(fixture.admin) ? fixture.admin : null;
  const expectedRepository = 'a48zhang/sub2api-cloudflare';
  if (fixture.repository !== expectedRepository || fixture.prNumber !== 5 || fixture.runId !== 'qa-pr5-20261004') {
    throw new Error('QA fixture is not the authorized PR #5 fixture.');
  }
  if (process.env.GITHUB_REPOSITORY !== expectedRepository || process.env.PR_NUMBER !== '5') {
    throw new Error('Refusing to seed outside the authorized repository and PR #5.');
  }
  if (!/^[a-f0-9]{40}$/.test(process.env.PR_HEAD_SHA || '')) {
    throw new Error('PR_HEAD_SHA must be the current 40-character commit SHA.');
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !accountIdPattern.test(process.env.CLOUDFLARE_ACCOUNT_ID || '')
    || process.env.CLOUDFLARE_ACCOUNT_ID !== fixture.accountId) {
    throw new Error('Cloudflare CI credentials do not match the authorized preview account.');
  }
  if (typeof fixture.accountId !== 'string' || !accountIdPattern.test(fixture.accountId)
    || typeof fixture.workerName !== 'string' || !/^sub2api-[a-f0-9]{10}-pr-5$/.test(fixture.workerName)
    || typeof fixture.databaseName !== 'string' || !/^sub2api-[a-f0-9]{10}-preview$/.test(fixture.databaseName)
    || typeof fixture.baseURL !== 'string' || typeof fixture.publicKey !== 'string'
    || typeof fixture.runId !== 'string' || !admin
    || typeof admin.id !== 'string' || !uuidPattern.test(admin.id)
    || typeof admin.email !== 'string') {
    throw new Error('QA fixture metadata is invalid.');
  }
  const email = normalizeEmail(admin.email);
  if (email !== admin.email) throw new Error('QA fixture email must already be normalized.');
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(fixture.publicKey);
  } catch {
    throw new Error('QA fixture public key is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength !== 4096) {
    throw new Error('QA fixture must contain the authorized RSA-4096 public key.');
  }

  const config = await readJsonRecord(configPath, 'Generated PR #5 preview config');
  const vars = isRecord(config.vars) ? config.vars : null;
  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : null;
  const namespaces = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : null;
  if (Object.hasOwn(config, 'env') || config.account_id !== fixture.accountId
    || config.name !== fixture.workerName || config.workers_dev !== true || config.preview_urls !== false
    || !vars || vars.ENVIRONMENT !== 'staging' || vars.PUBLIC_BASE_URL !== fixture.baseURL
    || !databases || databases.length !== 1 || !isRecord(databases[0])
    || databases[0].binding !== 'DB' || databases[0].database_name !== fixture.databaseName
    || typeof databases[0].database_id !== 'string' || !databaseUuidPattern.test(databases[0].database_id)
    || !namespaces || namespaces.length !== 1 || !isRecord(namespaces[0])
    || namespaces[0].binding !== 'CACHE' || typeof namespaces[0].id !== 'string'
    || !accountIdPattern.test(namespaces[0].id)) {
    throw new Error('Generated preview config does not exactly match the authorized PR #5 target.');
  }
  const url = new URL(fixture.baseURL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev')
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('QA fixture base URL is invalid.');
  }
  const target: Target = {
    accountId: fixture.accountId,
    workerName: fixture.workerName,
    databaseName: fixture.databaseName,
    databaseId: databases[0].database_id,
    namespaceId: namespaces[0].id,
  };
  return { fixture, target, email };
}

async function runWranglerSql(sql: string): Promise<unknown> {
  const cli = join(root, 'apps/worker/node_modules/wrangler/bin/wrangler.js');
  const stdout = await new Promise<string>((accept, reject) => {
    const child = spawn(process.execPath, [cli, 'd1', 'execute', 'DB', '--remote', '--config', configPath, '--command', sql, '--json'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    let captured = '';
    let capturedBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(captured);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Wrangler D1 command timed out; the remote result may be unknown.'));
    }, 60_000);
    if (!child.stdout || !child.stderr) {
      child.kill();
      finish(new Error('Could not capture Wrangler D1 output safely.'));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      capturedBytes += Buffer.byteLength(chunk, 'utf8');
      if (capturedBytes > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error('Wrangler D1 returned unexpected output; remote result may be unknown.'));
      } else if (!settled) captured += chunk;
    });
    // Wrangler diagnostics can contain SQL text; never forward or retain stderr.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Could not start the Wrangler D1 command.')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('Wrangler D1 command failed; remote result may be unknown.')));
  });
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Wrangler D1 output was not valid JSON; remote result may be unknown.');
  }
}

function rowsFromWranglerOutput(output: unknown): JsonRecord[] {
  if (!Array.isArray(output) || output.length === 0) throw new Error('Wrangler D1 output did not contain a result batch.');
  const rows: JsonRecord[] = [];
  for (const batch of output) {
    if (!isRecord(batch) || batch.success !== true || !Array.isArray(batch.results)) {
      throw new Error('Wrangler D1 reported an unsuccessful result batch.');
    }
    for (const row of batch.results) {
      if (!isRecord(row)) throw new Error('Wrangler D1 returned an invalid row.');
      rows.push(row);
    }
  }
  return rows;
}

async function writeEncryptedCredentials(input: {
  fixture: JsonRecord;
  target: Target;
  head: string;
  email: string;
  password: string;
}): Promise<void> {
  const admin = input.fixture.admin as JsonRecord;
  const publicKey = createPublicKey(input.fixture.publicKey as string);
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({
    runId: input.fixture.runId,
    head: input.head,
    baseURL: input.fixture.baseURL,
    admin: { id: admin.id, email: input.email, password: input.password, role: 'admin' },
    target: input.target,
  }), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encryptedKey = publicEncrypt({
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, aesKey);
    const document = {
      schema: 1,
      encryptedKey: encryptedKey.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await writeFile(credentialPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
  } finally {
    aesKey.fill(0);
    plaintext.fill(0);
  }
}

async function main(): Promise<void> {
  const { fixture, target, email } = await validateTarget();
  // A prior attempt in a reused runner must never make stale credentials uploadable.
  await rm(credentialPath, { force: true });
  const existingRows = rowsFromWranglerOutput(await runWranglerSql(buildSelectSql(email)));
  if (existingRows.length > 1) throw new Error('QA email matched multiple database rows; refusing to continue.');
  if (existingRows.length === 1) {
    const existing = existingRows[0]!;
    const admin = fixture.admin as JsonRecord;
    if (existing.id !== admin.id || existing.role !== 'admin') {
      throw new Error('The QA email already belongs to a different identity or role; refusing to modify it.');
    }
    process.stdout.write('PR #5 QA account already exists with the expected identity; no changes made.\n');
    return;
  }

  const admin = fixture.admin as JsonRecord;
  let password = randomBytes(32).toString('base64url');
  let passwordHash = '';
  try {
    passwordHash = await hashPassword(password);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('System time is invalid for the QA seed.');
    await writeEncryptedCredentials({
      fixture,
      target,
      head: process.env.PR_HEAD_SHA!,
      email,
      password,
    });
    const rows = rowsFromWranglerOutput(await runWranglerSql(
      buildInsertSql(email, passwordHash, admin.id as string, now),
    ));
    const created = rows.length === 1 && rows[0]!.id === admin.id && rows[0]!.role === 'admin'
      && rows[0]!.status === 'active' && rows[0]!.balance_units === '0';
    if (!created) throw new Error('QA seed insertion was not confirmed; encrypted credentials were retained for reconciliation.');
    process.stdout.write('Created the PR #5 QA administrator; credentials are available only in the encrypted artifact.\n');
  } finally {
    password = '';
    passwordHash = '';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'PR #5 QA seeding failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
