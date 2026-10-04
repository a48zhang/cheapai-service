import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(join(repositoryRoot, 'package.json'));
const typescript = requireFromRoot('typescript');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function runAndCapture(command, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => reject(new Error('Could not locate the configured workspace package.')));
    child.once('close', (code) => {
      if (code === 0) accept(output.trim());
      else reject(new Error('Could not locate the configured workspace package. Ensure dependencies are installed and pnpm-workspace.yaml includes it.'));
    });
  });
}

async function workspacePackagePath(name) {
  const packagePath = await runAndCapture(
    pnpm,
    ['--silent', '--filter', name, 'exec', 'node', '-p', 'process.cwd()'],
    { cwd: repositoryRoot, env: process.env },
  );
  const packageRoot = resolve(packagePath.split(/\r?\n/).at(-1) ?? '');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== name) throw new Error(`Workspace package path did not resolve to ${name}.`);
  return packageRoot;
}

function configuredPort(value, name, fallback) {
  if (value === undefined || value.trim() === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

function configuredPath(packageRoot, value) {
  return isAbsolute(value) ? value : resolve(packageRoot, value);
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    taskkill.unref();
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function main() {
  const webRoot = await workspacePackagePath('@cheapai/web');
  const workerRoot = await workspacePackagePath('@sub2api/worker');
  const webPath = relative(repositoryRoot, webRoot).split(sep).join('/');
  const localEnvironment = join(webRoot, '.env.local');
  try {
    await access(localEnvironment, constants.R_OK);
    process.loadEnvFile(localEnvironment);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Could not read ${localEnvironment}.`);
  }

  const keyFile = process.env.CHEAPAI_WEB_TLS_KEY_FILE;
  const certFile = process.env.CHEAPAI_WEB_TLS_CERT_FILE;
  if (!keyFile || !certFile) {
    throw new Error(`Copy ${webPath}/.env.example to ${webPath}/.env.local and set CHEAPAI_WEB_TLS_KEY_FILE and CHEAPAI_WEB_TLS_CERT_FILE to a trusted local certificate pair.`);
  }

  const keyPath = configuredPath(webRoot, keyFile);
  const certPath = configuredPath(webRoot, certFile);
  try {
    await Promise.all([access(keyPath, constants.R_OK), access(certPath, constants.R_OK)]);
  } catch {
    throw new Error('The configured local HTTPS key or certificate file cannot be read. Check CHEAPAI_WEB_TLS_KEY_FILE and CHEAPAI_WEB_TLS_CERT_FILE in apps/web/.env.local.');
  }

  const webPort = configuredPort(process.env.CHEAPAI_WEB_PORT, 'CHEAPAI_WEB_PORT', 5173);
  const workerPort = configuredPort(process.env.CHEAPAI_WORKER_PORT, 'CHEAPAI_WORKER_PORT', 8787);
  if (webPort === workerPort) throw new Error('CHEAPAI_WEB_PORT and CHEAPAI_WORKER_PORT must be different.');

  const publicBaseUrl = `https://127.0.0.1:${webPort}`;
  const stateRoot = join(repositoryRoot, '.wrangler', 'cheapai-react-dev');
  const runRoot = join(stateRoot, 'runs', randomUUID());
  const stateDirectory = join(stateRoot, 'state');
  const emptyAssetsDirectory = join(stateRoot, 'empty-assets');
  await Promise.all([
    mkdir(runRoot, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(emptyAssetsDirectory, { recursive: true }),
  ]);

  let services = [];
  let stopping = false;
  let stopSignal = 'SIGTERM';
  let exitCode = 0;
  let closedServices = 0;
  let resolveClosed;
  const allServicesClosed = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  let forceStopTimer;

  function stopServices(signal = 'SIGTERM') {
    if (!stopping) {
      stopping = true;
      stopSignal = signal;
      for (const service of services) signalProcessTree(service.child, stopSignal);
      forceStopTimer = setTimeout(() => {
        for (const service of services) signalProcessTree(service.child, 'SIGKILL');
      }, 10_000);
      forceStopTimer.unref();
    }
  }

  function serviceClosed(service, code) {
    service.closed = true;
    closedServices += 1;
    if (!stopping) {
      exitCode = code === 0 ? 1 : code ?? 1;
      stopServices();
    }
    if (closedServices === services.length) {
      clearTimeout(forceStopTimer);
      resolveClosed();
    }
  }

  function startNodeService(label, script, args, cwd, env) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: 'inherit',
    });
    const service = { label, child, closed: false };
    child.once('error', (error) => {
      console.error(`Could not start ${label}: ${error.message}`);
      exitCode = 1;
      stopServices();
    });
    child.once('close', (code) => serviceClosed(service, code));
    return service;
  }

  const onInterrupt = () => stopServices('SIGTERM');
  const onTerminate = () => stopServices('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    if (stopping) return;
    const workerConfigPath = join(workerRoot, 'wrangler.jsonc');
    const parsed = typescript.parseConfigFileTextToJson(
      workerConfigPath,
      await readFile(workerConfigPath, 'utf8'),
    );
    if (parsed.error) throw new Error('Could not parse the local Wrangler configuration.');

    const config = parsed.config;
    delete config.$schema;
    delete config.env;
    delete config.triggers;
    config.main = join(workerRoot, 'index.ts');
    config.workers_dev = false;
    config.preview_urls = false;
    config.vars = {
      ...(config.vars ?? {}),
      ENVIRONMENT: 'local',
      PUBLIC_BASE_URL: publicBaseUrl,
      EMAIL_VERIFICATION_READY: config.vars?.EMAIL_VERIFICATION_READY ?? 'false',
    };
    config.assets = {
      ...(config.assets ?? {}),
      directory: emptyAssetsDirectory,
      binding: config.assets?.binding ?? 'ASSETS',
    };
    config.d1_databases = (config.d1_databases ?? []).map((database) => ({
      ...database,
      migrations_dir: resolve(workerRoot, database.migrations_dir ?? '../../migrations'),
      remote: false,
    }));
    config.kv_namespaces = (config.kv_namespaces ?? []).map((namespace) => ({ ...namespace, remote: false }));

    const sourceDevVars = join(workerRoot, '.dev.vars');
    const generatedDevVars = join(runRoot, '.dev.vars');
    try {
      await access(sourceDevVars, constants.R_OK);
      await copyFile(sourceDevVars, generatedDevVars, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Could not preserve the existing Worker .dev.vars configuration.');
      await writeFile(generatedDevVars, '', { flag: 'wx', mode: 0o600 });
    }
    await chmod(generatedDevVars, 0o600);

    const generatedConfigPath = join(runRoot, 'wrangler.json');
    await writeFile(generatedConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });

    const viteCli = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');
    const wranglerCli = join(workerRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const childEnvironment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
    delete childEnvironment.CLOUDFLARE_ENV;

    services = [
      startNodeService(
        'local Worker',
        wranglerCli,
        [
          'dev', '--config', generatedConfigPath, '--local', '--persist-to', stateDirectory,
          '--ip', '127.0.0.1', '--port', String(workerPort), '--local-protocol', 'http',
        ],
        workerRoot,
        childEnvironment,
      ),
      startNodeService(
        'Vite',
        viteCli,
        ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort', '--clearScreen', 'false'],
        webRoot,
        childEnvironment,
      ),
    ];
    if (stopping) {
      for (const service of services) signalProcessTree(service.child, stopSignal);
    }
    console.log(`cheapai React dev server: ${publicBaseUrl} (Worker API proxy: http://127.0.0.1:${workerPort})`);
    console.log('Press Ctrl+C to stop both local processes.');
    await allServicesClosed;
  } finally {
    stopServices();
    await Promise.all(services.map((service) => new Promise((resolvePromise) => {
      if (service.closed) return resolvePromise();
      service.child.once('close', resolvePromise);
    })));
    await rm(runRoot, { recursive: true, force: true });
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Could not start cheapai local development services.');
  process.exitCode = 1;
});
