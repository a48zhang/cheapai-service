import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read-only checks for a D1 database restored into an isolated target.
 *
 * This script deliberately owns no restore path and accepts no arbitrary SQL.
 * Each query below is fixed and is sent through Wrangler's `d1 execute` command.
 * A remote invocation must opt into `--isolated`; production-like targets are
 * rejected before Wrangler is started.
 */

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfig = 'apps/worker/wrangler.jsonc';
const defaultDatabase = 'DB';
const defaultLocalState = '.wrangler/r05-restore-verify';
const defaultLog = '.wrangler/verify-restored-database.log';
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const databasePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const expectedTables = [
  'groups', 'settings', 'users', 'sessions', 'api_keys', 'registration_codes',
  'email_challenges', 'channels', 'channel_groups', 'models', 'channel_models',
  'requests', 'billing_entries', 'admin_audit', 'registration_code_batches',
] as const;

const expectedTriggers = [
  'users_registration_guard', 'users_registration_consume',
  'billing_entries_validate_balance', 'billing_entries_validate_consumption',
  'billing_entries_apply_atomically', 'billing_entries_no_update',
  'billing_entries_no_delete', 'billing_entries_no_replace',
  'api_keys_creation_identity_immutable',
] as const;

const readOnlyQueries = {
  migrations: 'SELECT name FROM d1_migrations ORDER BY id;',
  schema: `SELECT name,type FROM sqlite_master
    WHERE type IN ('table','trigger')
      AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA'
    ORDER BY type,name;`,
  foreignKeys: 'PRAGMA foreign_key_check;',
  balances: `WITH per_user AS (
      SELECT u.id,u.balance_units,
        COALESCE((SELECT SUM(b.delta_units) FROM billing_entries b WHERE b.user_id=u.id),0) AS ledger_units,
        (SELECT COUNT(*) FROM billing_entries b WHERE b.user_id=u.id) AS entry_count
      FROM users u
    )
    SELECT COUNT(*) AS user_count,
      COALESCE(SUM(CASE WHEN balance_units=ledger_units THEN 0 ELSE 1 END),0) AS mismatched_users,
      COALESCE(SUM(CASE WHEN balance_units<0 THEN 1 ELSE 0 END),0) AS negative_users,
      COALESCE(SUM(entry_count),0) AS billing_entry_count
    FROM per_user;`,
  billing: `SELECT COUNT(*) AS entries,
      COUNT(DISTINCT operation_id) AS distinct_operations,
      COALESCE(SUM(CASE WHEN kind='consumption' THEN 1 ELSE 0 END),0) AS consumption_entries,
      COUNT(DISTINCT CASE WHEN kind='consumption' THEN request_id END) AS distinct_consumption_requests
    FROM billing_entries;`,
  apiKeyIdempotency: `SELECT COUNT(*) AS api_keys,
      COALESCE(SUM(CASE WHEN creation_operation_id IS NOT NULL THEN 1 ELSE 0 END),0) AS idempotent_keys,
      COALESCE(SUM(CASE WHEN (creation_operation_id IS NULL AND creation_fingerprint IS NOT NULL)
        OR (creation_operation_id IS NOT NULL AND creation_fingerprint IS NULL) THEN 1 ELSE 0 END),0)
        AS invalid_creation_pairs,
      (SELECT COUNT(*) FROM (
        SELECT user_id,creation_operation_id FROM api_keys
        WHERE creation_operation_id IS NOT NULL
        GROUP BY user_id,creation_operation_id HAVING COUNT(*) > 1
      )) AS duplicate_owner_operations
    FROM api_keys;`,
  registrationBatchIdempotency: `SELECT COUNT(*) AS duplicate_batch_operations FROM (
      SELECT actor_id,operation_id FROM registration_code_batches
      GROUP BY actor_id,operation_id HAVING COUNT(*) > 1
    );`,
  channelEnvelopes: `SELECT COUNT(*) AS channels,
      COALESCE(SUM(CASE WHEN secret_key_version IS NULL OR length(trim(secret_key_version))=0
        OR length(secret_key_version)>64 OR secret_key_version GLOB '*[^A-Za-z0-9._-]*'
        THEN 1 ELSE 0 END),0) AS invalid_versions,
      COALESCE(SUM(CASE WHEN json_valid(secret_ciphertext)=1
        AND json_type(secret_ciphertext)='object'
        AND (SELECT COUNT(*) FROM json_each(channels.secret_ciphertext))=5
        AND json_extract(secret_ciphertext,'$.algorithm')='A256GCM'
        AND json_extract(secret_ciphertext,'$.format_version')=1
        AND json_type(secret_ciphertext,'$.key_version')='text'
        AND json_extract(secret_ciphertext,'$.key_version')=secret_key_version
        AND json_type(secret_ciphertext,'$.nonce')='text'
        AND length(json_extract(secret_ciphertext,'$.nonce'))=16
        AND json_extract(secret_ciphertext,'$.nonce') NOT GLOB '*[^A-Za-z0-9_-]*'
        AND json_type(secret_ciphertext,'$.ciphertext')='text'
        AND length(json_extract(secret_ciphertext,'$.ciphertext'))>=23
        AND json_extract(secret_ciphertext,'$.ciphertext') NOT GLOB '*[^A-Za-z0-9_-]*'
        THEN 0 ELSE 1 END),0) AS invalid_envelopes
    FROM channels;`,
  channelVersions: 'SELECT DISTINCT secret_key_version AS key_version FROM channels ORDER BY secret_key_version;',
} as const;

type Mode = 'local' | 'remote';
type CheckStatus = 'pass' | 'fail';
type QueryRow = Record<string, unknown>;
type WranglerResult = { results: QueryRow[] };

interface Options {
  mode: Mode;
  database: string;
  config: string;
  environment?: string;
  persistTo?: string;
  keyVersions: Set<string>;
  isolated: boolean;
}

interface Check {
  id: string;
  status: CheckStatus;
  details: Record<string, unknown>;
}

interface Report {
  version: 1;
  checkedAt: string;
  target: { mode: Mode; database: string; environment: string | null };
  readOnly: true;
  secretValuesRead: false;
  checks: Check[];
  ok: boolean;
}

function usage(): string {
  return [
    'Read-only verification of a D1 database restored into an isolated target.',
    '',
    'Usage:',
    '  node scripts/verify-restored-database.ts --local [options]',
    '  node scripts/verify-restored-database.ts --remote --isolated [options]',
    '',
    'Options:',
    `  --database <name>             D1 database name or binding (default: ${defaultDatabase})`,
    `  --config <path>               Wrangler config path (default: ${defaultConfig})`,
    '  --env <name>                  Wrangler environment (remote only; never production)',
    `  --persist-to <path>           Local Wrangler state directory (default: ${defaultLocalState})`,
    '  --key-version <version>       Retained key version label; may be repeated',
    '  --key-versions-file <path>    Text file of retained labels, one per line; no key material',
    '  --json                        Kept for CLI compatibility; output is always JSON',
    '  --help                        Show this help',
    '',
    'Remote verification requires --isolated and rejects production-like target names.',
    'The command never restores, exports, migrates, repairs, or accepts arbitrary SQL.',
  ].join('\n');
}

function optionValue(argument: string, name: string): string | null {
  return argument === name ? '' : argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : null;
}

function takeValue(args: string[], index: number, argument: string, name: string): [string, number] {
  const inline = optionValue(argument, name);
  if (inline !== null && inline !== '') return [inline, index];
  if (inline === '' && index + 1 < args.length && !args[index + 1]!.startsWith('--')) return [args[index + 1]!, index + 1];
  throw new Error(`${name} requires a value.`);
}

function parseArgs(args: string[]): Options | null {
  let mode: Mode | undefined;
  let database = defaultDatabase;
  let config = defaultConfig;
  let environment: string | undefined;
  let persistTo: string | undefined;
  let isolated = false;
  const keyVersions = new Set<string>();
  const keyVersionFiles: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--help' || argument === '-h') return null;
    if (argument === '--json') continue;
    if (argument === '--local' || argument === '-l') {
      if (mode && mode !== 'local') throw new Error('Choose exactly one of --local or --remote.');
      mode = 'local'; continue;
    }
    if (argument === '--remote' || argument === '-r') {
      if (mode && mode !== 'remote') throw new Error('Choose exactly one of --local or --remote.');
      mode = 'remote'; continue;
    }
    if (argument === '--isolated') { isolated = true; continue; }
    if (argument === '--database' || argument.startsWith('--database=')) {
      const [value, next] = takeValue(args, index, argument, '--database'); database = value; index = next; continue;
    }
    if (argument === '--config' || argument.startsWith('--config=')) {
      const [value, next] = takeValue(args, index, argument, '--config'); config = value; index = next; continue;
    }
    if (argument === '--env' || argument.startsWith('--env=')) {
      const [value, next] = takeValue(args, index, argument, '--env'); environment = value; index = next; continue;
    }
    if (argument === '--persist-to' || argument.startsWith('--persist-to=')) {
      const [value, next] = takeValue(args, index, argument, '--persist-to'); persistTo = value; index = next; continue;
    }
    if (argument === '--key-version' || argument.startsWith('--key-version=')) {
      const [value, next] = takeValue(args, index, argument, '--key-version');
      if (!versionPattern.test(value)) throw new Error(`Invalid key version label: ${value}`);
      keyVersions.add(value); index = next; continue;
    }
    if (argument === '--key-versions-file' || argument.startsWith('--key-versions-file=')) {
      const [value, next] = takeValue(args, index, argument, '--key-versions-file');
      keyVersionFiles.push(resolveFromRoot(value));
      index = next; continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!mode) throw new Error('Specify exactly one of --local or --remote.');
  if (!databasePattern.test(database)) throw new Error(`Invalid D1 database name: ${database}`);
  if (mode === 'local' && isolated) throw new Error('--isolated is only valid with --remote.');
  if (mode === 'remote' && !isolated) throw new Error('--remote requires --isolated; this verifier must target a restored copy.');
  if (mode === 'local' && environment !== undefined) throw new Error('--env is only valid with --remote.');
  if (mode === 'remote' && persistTo !== undefined) throw new Error('--persist-to is only valid with --local.');

  if (mode === 'remote') {
    const targetText = `${database} ${environment ?? ''}`.toLowerCase();
    // The guard is intentionally conservative: an isolated database should be
    // named for its restore/recovery purpose, and this tool must never be used
    // as an accidental production read path.
    if (/(prod(?:uction)?|live)/.test(targetText)) {
      throw new Error('Production-like remote targets are refused by the read-only restore verifier.');
    }
  }

  // Validate the target before opening any optional file. This keeps an
  // accidental production invocation from reading a path that was meant for
  // labels but could contain Secret material.
  for (const path of keyVersionFiles) {
    if (!existsSync(path)) throw new Error(`Key version label file does not exist: ${path}`);
    for (const [lineNumber, raw] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
      const label = raw.replace(/^\uFEFF/, '').trim();
      if (label === '' || label.startsWith('#')) continue;
      if (!versionPattern.test(label)) throw new Error(`Invalid key version label at ${path}:${lineNumber + 1}`);
      keyVersions.add(label);
    }
  }

  return {
    mode,
    database,
    config: resolveFromRoot(config),
    ...(environment === undefined ? {} : { environment }),
    ...(persistTo === undefined ? {} : { persistTo: resolveFromRoot(persistTo) }),
    keyVersions,
    isolated,
  };
}

function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(scriptRoot, path);
}

function numberValue(row: QueryRow, field: string): number {
  const value = row[field];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid numeric result for ${field}.`);
  return parsed;
}

function textValue(row: QueryRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid text result for ${field}.`);
  return value;
}

function readJsonOutput(stdout: string): WranglerResult {
  const cleaned = stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Wrangler did not return JSON results.');
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error('Unexpected Wrangler JSON result shape.');
  }
  const result = parsed[0] as Record<string, unknown>;
  if (!Array.isArray(result.results)) throw new Error('Wrangler JSON result has no results array.');
  return { results: result.results as QueryRow[] };
}

async function runQuery(options: Options, sql: string): Promise<QueryRow[]> {
  const wrangler = resolve(scriptRoot, 'apps/worker/node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(wrangler)) throw new Error('Local Wrangler is missing; run pnpm install --frozen-lockfile first.');
  const logPath = resolve(scriptRoot, defaultLog);
  mkdirSync(dirname(logPath), { recursive: true });
  if (options.mode === 'local') mkdirSync(options.persistTo ?? resolve(scriptRoot, defaultLocalState), { recursive: true });

  const commandArgs = [
    wrangler, 'd1', 'execute', options.database,
    '--config', options.config,
    ...(options.environment === undefined ? [] : ['--env', options.environment]),
    options.mode === 'local' ? '--local' : '--remote',
    ...(options.mode === 'local' ? ['--persist-to', options.persistTo ?? resolve(scriptRoot, defaultLocalState)] : []),
    '--command', sql, '--json',
  ];
  const childEnvironment = {
    ...process.env,
    NO_COLOR: '1',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: logPath,
  };

  return await new Promise<QueryRow[]>((resolveQuery, rejectQuery) => {
    const child = spawn(process.execPath, commandArgs, { cwd: scriptRoot, env: childEnvironment, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', () => { /* Keep CLI diagnostics in the Wrangler log, never in report output. */ });
    child.on('error', () => rejectQuery(new Error('Could not start local Wrangler.')));
    child.on('close', code => {
      if (code !== 0) return rejectQuery(new Error('Wrangler read-only query failed; inspect the local Wrangler log.'));
      try { resolveQuery(readJsonOutput(stdout).results); }
      catch { rejectQuery(new Error('Wrangler returned an unreadable read-only result.')); }
    });
  });
}

function pass(id: string, details: Record<string, unknown>): Check {
  return { id, status: 'pass', details };
}

function fail(id: string, details: Record<string, unknown>): Check {
  return { id, status: 'fail', details };
}

async function runCheck(options: Options, id: string, query: string, evaluate: (rows: QueryRow[]) => Check): Promise<Check> {
  try { return evaluate(await runQuery(options, query)); }
  catch { return fail(id, { reason: 'read-only query failed; see the local Wrangler log' }); }
}

async function verify(options: Options): Promise<Report> {
  const checks: Check[] = [];
  const migrationFiles = readMigrationNames();

  checks.push(await runCheck(options, 'migrations', readOnlyQueries.migrations, rows => {
    const applied = rows.map(row => textValue(row, 'name'));
    const missing = migrationFiles.filter(name => !applied.includes(name));
    const unexpected = applied.filter(name => !migrationFiles.includes(name));
    const inOrder = applied.length === migrationFiles.length && applied.every((name, index) => name === migrationFiles[index]);
    return missing.length === 0 && unexpected.length === 0 && inOrder
      ? pass('migrations', { expected: migrationFiles.length, applied: applied.length })
      : fail('migrations', { expected: migrationFiles.length, applied: applied.length, missing, unexpected, ordered: inOrder });
  }));

  checks.push(await runCheck(options, 'schema', readOnlyQueries.schema, rows => {
    const tables = new Set(rows.filter(row => row.type === 'table').map(row => textValue(row, 'name')));
    const triggers = new Set(rows.filter(row => row.type === 'trigger').map(row => textValue(row, 'name')));
    const missingTables = expectedTables.filter(name => !tables.has(name));
    const missingTriggers = expectedTriggers.filter(name => !triggers.has(name));
    return missingTables.length === 0 && missingTriggers.length === 0
      ? pass('schema', { tables: tables.size, triggers: triggers.size })
      : fail('schema', { missingTables, missingTriggers });
  }));

  checks.push(await runCheck(options, 'foreign-keys', readOnlyQueries.foreignKeys, rows => (
    rows.length === 0 ? pass('foreign-keys', { violations: 0 }) : fail('foreign-keys', { violations: rows.length })
  )));

  checks.push(await runCheck(options, 'balances-ledger', readOnlyQueries.balances, rows => {
    if (rows.length !== 1) return fail('balances-ledger', { reason: 'unexpected aggregate result' });
    const row = rows[0]!;
    const users = numberValue(row, 'user_count');
    const mismatched = numberValue(row, 'mismatched_users');
    const negative = numberValue(row, 'negative_users');
    const entries = numberValue(row, 'billing_entry_count');
    return mismatched === 0
      ? pass('balances-ledger', { users, billingEntries: entries, negativeUsers: negative, mismatchedUsers: mismatched })
      : fail('balances-ledger', { users, billingEntries: entries, negativeUsers: negative, mismatchedUsers: mismatched });
  }));

  checks.push(await runCheck(options, 'billing-idempotency', readOnlyQueries.billing, rows => {
    if (rows.length !== 1) return fail('billing-idempotency', { reason: 'unexpected aggregate result' });
    const row = rows[0]!;
    const entries = numberValue(row, 'entries');
    const distinctOperations = numberValue(row, 'distinct_operations');
    const consumptionEntries = numberValue(row, 'consumption_entries');
    const distinctConsumptionRequests = numberValue(row, 'distinct_consumption_requests');
    const valid = entries === distinctOperations && consumptionEntries === distinctConsumptionRequests;
    return valid
      ? pass('billing-idempotency', { entries, distinctOperations, consumptionEntries, distinctConsumptionRequests })
      : fail('billing-idempotency', { entries, distinctOperations, consumptionEntries, distinctConsumptionRequests });
  }));

  checks.push(await runCheck(options, 'api-key-idempotency', readOnlyQueries.apiKeyIdempotency, rows => {
    if (rows.length !== 1) return fail('api-key-idempotency', { reason: 'unexpected aggregate result' });
    const row = rows[0]!;
    const keys = numberValue(row, 'api_keys');
    const idempotent = numberValue(row, 'idempotent_keys');
    const invalidPairs = numberValue(row, 'invalid_creation_pairs');
    const duplicateOwners = numberValue(row, 'duplicate_owner_operations');
    return invalidPairs === 0 && duplicateOwners === 0
      ? pass('api-key-idempotency', { keys, idempotentKeys: idempotent, invalidCreationPairs: invalidPairs, duplicateOwnerOperations: duplicateOwners })
      : fail('api-key-idempotency', { keys, idempotentKeys: idempotent, invalidCreationPairs: invalidPairs, duplicateOwnerOperations: duplicateOwners });
  }));

  checks.push(await runCheck(options, 'registration-batch-idempotency', readOnlyQueries.registrationBatchIdempotency, rows => {
    if (rows.length !== 1) return fail('registration-batch-idempotency', { reason: 'unexpected aggregate result' });
    const duplicates = numberValue(rows[0]!, 'duplicate_batch_operations');
    return duplicates === 0 ? pass('registration-batch-idempotency', { duplicateOperations: duplicates })
      : fail('registration-batch-idempotency', { duplicateOperations: duplicates });
  }));

  const channelCheck = await runCheck(options, 'channel-secret-envelopes', readOnlyQueries.channelEnvelopes, rows => {
    if (rows.length !== 1) return fail('channel-secret-envelopes', { reason: 'unexpected aggregate result' });
    const row = rows[0]!;
    const channels = numberValue(row, 'channels');
    const invalidVersions = numberValue(row, 'invalid_versions');
    const invalidEnvelopes = numberValue(row, 'invalid_envelopes');
    return invalidVersions === 0 && invalidEnvelopes === 0
      ? pass('channel-secret-envelopes', { channels, invalidVersions, invalidEnvelopes })
      : fail('channel-secret-envelopes', { channels, invalidVersions, invalidEnvelopes });
  });
  checks.push(channelCheck);

  if (channelCheck.status === 'pass') {
    const channelCount = Number(channelCheck.details.channels);
    if (channelCount > 0) {
      const versionCheck = await runCheck(options, 'channel-key-version-labels', readOnlyQueries.channelVersions, rows => {
        const databaseVersions = rows.map(row => textValue(row, 'key_version'));
        if (options.keyVersions.size === 0) {
          return fail('channel-key-version-labels', { reason: 'provide --key-versions-file or --key-version for a populated database', databaseVersions });
        }
        const missing = databaseVersions.filter(version => !options.keyVersions.has(version));
        return missing.length === 0
          ? pass('channel-key-version-labels', { databaseVersions, manifestLabels: options.keyVersions.size, keyMaterialRead: false })
          : fail('channel-key-version-labels', { databaseVersions, missing, manifestLabels: options.keyVersions.size, keyMaterialRead: false });
      });
      checks.push(versionCheck);
    } else {
      checks.push(pass('channel-key-version-labels', { channels: 0, skipped: true, keyMaterialRead: false }));
    }
  }

  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    target: { mode: options.mode, database: options.database, environment: options.environment ?? null },
    readOnly: true,
    secretValuesRead: false,
    checks,
    ok: checks.length > 0 && checks.every(check => check.status === 'pass'),
  };
}

function readMigrationNames(): string[] {
  const migrationDirectory = resolve(scriptRoot, 'migrations');
  if (!existsSync(migrationDirectory)) throw new Error(`Migrations directory does not exist: ${migrationDirectory}`);
  // The migration names are read from checked-in filenames only; no SQL is loaded
  // and no migration command is ever issued by this verifier.
  return readdirSync(migrationDirectory)
    .filter(name => /^\d{4}_[^/\\]+\.sql$/.test(name))
    .sort();
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2))!;
    if (!existsSync(options.config)) throw new Error(`Wrangler config does not exist: ${options.config}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const report = await verify(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Verification failed'}\n`);
  process.exitCode = 2;
});
