import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword, validatePasswordInput } from '../apps/worker/auth/password.ts';
import { normalizeEmail } from '../apps/worker/auth/email-proof.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Explicit initial limits; an administrator may change these through A24.
const initialLimits = { concurrency: Number.MAX_SAFE_INTEGER, rpm: Number.MAX_SAFE_INTEGER };
type Target = { mode: 'local' | 'remote'; environment?: 'production'; preview?: string; persistTo?: string };

export function parseTarget(args: readonly string[]): Target {
  let mode: Target['mode'] | undefined;
  let environment: Target['environment'];
  let persistTo: string | undefined;
  let preview: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--local' || arg === '--remote') {
      if (mode) throw new Error('Specify exactly one of --local or --remote.');
      mode = arg === '--local' ? 'local' : 'remote';
    } else if (arg === '--env') {
      const value = args[++i];
      if (environment || value !== 'production') throw new Error('--env must be production; shared staging is retired. Use --preview PR_NUMBER for a PR.');
      environment = value;
    } else if (arg === '--preview') {
      const value = args[++i];
      if (preview || !value || !/^[1-9][0-9]{0,9}$/.test(value)) throw new Error('--preview requires a positive PR number.');
      preview = value;
    } else if (arg === '--persist-to') {
      const value = args[++i];
      if (persistTo || !value || value.startsWith('--')) throw new Error('--persist-to requires one local directory.');
      persistTo = resolve(value);
    } else throw new Error('Unknown argument. Passwords and email must be entered interactively.');
  }
  if (!mode || (mode === 'remote' && !environment && !preview) || (mode === 'local' && (environment || preview))
    || (environment && preview) || (mode === 'remote' && persistTo)) {
    throw new Error('Use --local [--persist-to directory], --remote --env production, or --remote --preview PR_NUMBER.');
  }
  return { mode, ...(environment ? { environment } : {}), ...(preview ? { preview } : {}), ...(persistTo ? { persistTo } : {}) };
}

/** Literal text encoded as UTF-8 bytes; no user-controlled SQL syntax. */
function sqlText(value: string): string { return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`; }

export function buildBootstrapSql(email: string, passwordHash: string, id: string, now: number): string {
  const normalized = normalizeEmail(email);
  if (passwordHash.trim() !== passwordHash || !/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(passwordHash)
    || id.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid bootstrap identity.');
  // One statement owns the race. Even a disabled administrator prevents a
  // second bootstrap; this command never resets or promotes an existing user.
  return `INSERT INTO users
    (id,email_normalized,password_hash,role,status,email_verified_at,group_id,balance_units,
     concurrency_limit,rpm_limit,created_via,registration_code_id,created_at,updated_at)
    SELECT ${sqlText(id)},${sqlText(normalized)},${sqlText(passwordHash)},'admin','active',NULL,g.id,0,
      ${initialLimits.concurrency},${initialLimits.rpm},'bootstrap',NULL,${now},${now}
    FROM settings s JOIN groups g ON g.id=json_extract(s.value_json,'$')
    WHERE s.key='default_group_id' AND g.status='active'
      AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin')
      AND NOT EXISTS (SELECT 1 FROM users WHERE email_normalized=${sqlText(normalized)})
    RETURNING id,email_normalized,role,status,CAST(balance_units AS TEXT) AS balance_units;\n`;
}

async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive terminal is required.');
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((accept, reject) => {
    let value = '';
    function done(error?: Error) {
      process.stdin.removeListener('keypress', keypress);
      process.stdin.setRawMode(previousRaw); process.stdin.pause();
      process.stdout.write('\n');
      if (error) { value = ''; reject(error); } else { accept(value); value = ''; }
    }
    function keypress(text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return done(new Error('Cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return done();
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl || key.meta || !text || /[\u0000-\u001f\u007f]/u.test(text)) return;
      value += text;
      if (Buffer.byteLength(value, 'utf8') > 512) done(new Error('Password exceeds 512 UTF-8 bytes.'));
    }
    process.stdin.on('keypress', keypress);
  });
}

async function execute(target: Target, filename: string): Promise<unknown> {
  let configPath = join(root, 'apps/worker/wrangler.jsonc');
  if (target.preview) {
    // Generated by pr-preview.mjs --config-only; never fall back to production or a retired shared environment.
    configPath = join(root, `.wrangler/pr-preview-${target.preview}.json`);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const { createHash } = await import('node:crypto');
    const repository = process.env.GITHUB_REPOSITORY || 'a48zhang/sub2api-cloudflare';
    const prefix = `sub2api-${createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 10)}`;
    const expected = `${prefix}-pr-${target.preview}`;
    if (config.name !== expected || config.env || config.d1_databases?.length !== 1
      || config.d1_databases[0].binding !== 'DB' || config.d1_databases[0].database_name !== `${prefix}-preview`) {
      throw new Error('Preview config does not match this PR. Regenerate it with pr-preview.mjs --config-only.');
    }
  }
  const args = [join(root, 'apps/worker/node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB',
    '--config', configPath, `--${target.mode}`, '--file', filename, '--json'];
  if (target.environment) args.push('--env', target.environment);
  if (target.persistTo) args.push('--persist-to', target.persistTo);
  const output = await new Promise<string>((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    let text = ''; let bytes = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else accept(text);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Database command timed out; outcome may be unknown. Do not reset any existing account.')); }, 120_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 2 * 1024 * 1024) { child.kill(); finish(new Error('Unexpected database output. Verify the existing administrator before retrying.')); }
      else text += chunk;
    });
    // Do not echo CLI diagnostics: a database failure may include SQL/hash text.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Could not start the local Wrangler command.')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('Database command failed. Verify bindings, migrations and existing administrator; no automatic retry.')));
  });
  try { return JSON.parse(output); }
  catch { throw new Error('Database output was not valid JSON; verify the existing administrator before retrying.'); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('node scripts/bootstrap-admin.ts --local [--persist-to directory]\nnode scripts/bootstrap-admin.ts --remote --env production\nnode scripts/bootstrap-admin.ts --remote --preview PR_NUMBER\nPasswords are entered without echo; an existing administrator is never changed.\n');
    return;
  }
  const target = parseTarget(args);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (process.versions.node !== pkg.engines.node) throw new Error(`Use Node ${pkg.engines.node}.`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run from an interactive terminal; piped credentials are not accepted.');
  process.stdout.write(`Target: ${target.mode === 'local' ? 'local D1' : (target.preview ? 'shared preview (via PR #' + target.preview + ')' : target.environment) + ' remote D1'}${target.persistTo ? ' (' + target.persistTo + ')' : ''}\n`);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let email: string;
  try { email = normalizeEmail(await input.question('Initial administrator email: ')); }
  finally { input.close(); }
  let password = await secret('Password (hidden): ');
  let confirmation = await secret('Repeat password (hidden): ');
  if (password !== confirmation || !validatePasswordInput(password).valid) {
    password = ''; confirmation = ''; throw new Error('Passwords must match and satisfy the 6–128 character / 512-byte policy.');
  }
  confirmation = '';
  const passwordHash = await hashPassword(password); password = '';
  const id = crypto.randomUUID();
  const sql = buildBootstrapSql(email, passwordHash, id, Date.now());
  const temporary = await mkdtemp(join(tmpdir(), 'sub2api-bootstrap-'));
  try {
    const filename = join(temporary, 'bootstrap.sql');
    await writeFile(filename, sql, { encoding: 'utf8', mode: 0o600 });
    const result = await execute(target, filename);
    const created = Array.isArray(result) && result.some(batch => batch?.success === true
      && Array.isArray(batch.results) && batch.results.some((row: Record<string, unknown>) => row.id === id && row.role === 'admin' && row.balance_units === '0'));
    if (!created) throw new Error('No administrator created. An administrator/email already exists, or the default group is unavailable. Existing accounts were not changed.');
    process.stdout.write(`Created administrator ${email} (${id}), initial balance 0. Registration policy is unchanged.\n`);
  } finally {
    // The directory is created above by mkdtemp, never derived from user input.
    await rm(join(temporary, 'bootstrap.sql'), { force: true });
    await rmdir(temporary);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Bootstrap failed.'}\n`); process.exitCode = 1; });
}
