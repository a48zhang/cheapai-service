import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { packageRuntime } from './package-runtime.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const resourceRoot = join(repositoryRoot, 'apps/desktop/src-tauri/resources/generated/runtime')
const downloadCache = join(repositoryRoot, 'apps/desktop/.cache/runtime-downloads')
const maximumDownloadBytes = 512 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function parseArgs(argv) {
  const options = { target: undefined, runtime: undefined, output: resourceRoot }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target') options.target = argv[++index]
    else if (arg === '--runtime') options.runtime = argv[++index]
    else if (arg === '--output') options.output = resolve(repositoryRoot, argv[++index] ?? '')
    else fail(`Unknown argument: ${arg}`)
    if (argv[index] === undefined || argv[index] === '') fail(`Missing value after ${arg}`)
  }
  if (!options.target || !options.runtime) {
    fail('Usage: node scripts/desktop/prepare-runtime.mjs --target <Rust target triple> --runtime <bun|node> [--output <directory>]')
  }
  if (options.runtime !== 'bun' && options.runtime !== 'node') {
    fail(`Unsupported runtime ${options.runtime}; choose bun or node`)
  }
  if (!isInside(repositoryRoot, options.output)) {
    fail(`Generated Runtime output must stay inside the repository: ${options.output}`)
  }
  return options
}

function hostTarget() {
  const os = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'linux'
        ? 'Linux'
        : process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  const tripleArch = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch
  const tripleOs = os === 'macOS'
    ? 'apple-darwin'
    : os === 'Windows'
      ? 'pc-windows-msvc'
      : os === 'Linux'
        ? 'unknown-linux-gnu'
        : null
  return { os, arch, triple: tripleOs ? `${tripleArch}-${tripleOs}` : null }
}

function findTarget(versions, triple) {
  const target = versions.targets.find((entry) => entry.triple === triple)
  if (target) return target
  if (triple === 'x86_64-unknown-linux-gnu') return { os: 'Linux', arch: 'x64', triple }
  fail(`Unsupported desktop target triple: ${triple}`)
}

function findArtifact(versions, runtimeName, triple) {
  const runtime = versions.runtimes[runtimeName]
  if (!runtime?.version) fail(`No pinned version exists for runtime ${runtimeName}`)
  const artifact = runtime.artifacts?.[triple]
  if (!artifact) {
    fail(`No pinned ${runtimeName} artifact exists for ${triple} in scripts/desktop/runtime-versions.json; add its official HTTPS URL, SHA-256, archive format, and executablePath before packaging`)
  }
  if (typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    fail(`The pinned ${runtimeName} artifact for ${triple} must include a URL and a 64-character SHA-256`)
  }
  if (!['zip', 'tar.gz', 'tar.xz', 'tar.bz2', 'raw'].includes(artifact.archive)) {
    fail(`Unsupported archive format for ${runtimeName} ${triple}: ${artifact.archive}`)
  }
  if (typeof artifact.executablePath !== 'string' || !artifact.executablePath) {
    fail(`The pinned ${runtimeName} artifact for ${triple} is missing executablePath`)
  }
  const url = new URL(artifact.url)
  if (url.protocol !== 'https:' || !['github.com', 'nodejs.org'].includes(url.hostname)) {
    fail(`Runtime downloads must use an official HTTPS release host: ${artifact.url}`)
  }
  return { ...artifact, sha256: artifact.sha256.toLowerCase(), version: runtime.version }
}

function extensionFor(artifact) {
  if (artifact.archive === 'raw') return extname(new URL(artifact.url).pathname) || '.bin'
  return artifact.archive === 'zip' ? '.zip' : `.${artifact.archive.replace('.', '-')}`
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadPinnedArtifact(artifact, runtimeName, triple) {
  await mkdir(downloadCache, { recursive: true })
  const filename = `${runtimeName}-${artifact.version}-${triple}-${artifact.sha256}${extensionFor(artifact)}`
  const cachedPath = join(downloadCache, filename)
  const cachedStats = await lstat(cachedPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (cachedStats?.isFile()) {
    const digest = await hashFile(cachedPath)
    if (digest === artifact.sha256) return cachedPath
    await rm(cachedPath, { force: true })
  } else if (cachedStats) {
    fail(`Runtime download cache entry is not a regular file: ${cachedPath}`)
  }

  const response = await fetch(artifact.url, {
    headers: { 'user-agent': 'sub2api-desktop-runtime-preparer' },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok || !response.body) fail(`Download failed (${response.status}) for pinned Runtime artifact: ${artifact.url}`)
  const temporaryPath = `${cachedPath}.partial-${process.pid}`
  const byteLimit = new Transform({
    transform(chunk, _encoding, callback) {
      this.seen = (this.seen ?? 0) + chunk.length
      if (this.seen > maximumDownloadBytes) callback(new Error(`Runtime artifact exceeds ${maximumDownloadBytes} bytes`))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(response.body, byteLimit, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }))
    const digest = await hashFile(temporaryPath)
    if (digest !== artifact.sha256) {
      fail(`SHA-256 mismatch for ${artifact.url}: expected ${artifact.sha256}, received ${digest}`)
    }
    await rename(temporaryPath, cachedPath)
    return cachedPath
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function runExtractor(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) fail(`Could not start ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${command} could not unpack the pinned Runtime artifact: ${(result.stderr || result.stdout || '').trim()}`)
  }
}

async function extractArtifact(archivePath, artifact, destination) {
  await mkdir(destination, { recursive: true })
  if (artifact.archive === 'raw') {
    const path = resolve(destination, artifact.executablePath)
    if (!isInside(destination, path)) fail('Runtime executablePath must stay within the extracted artifact directory')
    await mkdir(dirname(path), { recursive: true })
    await copyFile(archivePath, path)
    return path
  }

  if (artifact.archive === 'zip' && process.platform === 'darwin') {
    runExtractor('/usr/bin/ditto', ['-x', '-k', archivePath, destination])
  } else if (artifact.archive === 'zip' && process.platform === 'win32') {
    runExtractor('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:RUNTIME_ARCHIVE_PATH -DestinationPath $env:RUNTIME_EXTRACT_PATH -Force',
    ], { ...process.env, RUNTIME_ARCHIVE_PATH: archivePath, RUNTIME_EXTRACT_PATH: destination })
  } else if (artifact.archive === 'zip') {
    runExtractor('unzip', ['-q', archivePath, '-d', destination])
  } else {
    runExtractor('tar', ['-xf', archivePath, '-C', destination])
  }

  const executable = resolve(destination, artifact.executablePath)
  if (!isInside(destination, executable)) fail('Pinned executablePath must stay within the extracted artifact directory')
  const stats = await lstat(executable).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!stats?.isFile()) fail(`Pinned runtime executablePath does not identify a file: ${artifact.executablePath}`)
  const resolvedExecutable = await realpath(executable)
  if (!isInside(await realpath(destination), resolvedExecutable)) {
    fail(`Runtime executable resolves outside its extracted artifact: ${artifact.executablePath}`)
  }
  return executable
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name)
    const relativePath = relative(root, path).split(sep).join('/')
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      const target = await realpath(path).catch(() => fail(`Broken symlink in Runtime resource tree: ${relativePath}`))
      if (!isInside(root, target)) fail(`Runtime resource symlink escapes the resource tree: ${relativePath}`)
      files.push({
        path: relativePath,
        kind: 'symlink',
        link: (await readlink(path)).split(sep).join('/'),
        target: relative(root, target).split(sep).join('/'),
      })
    } else if (stats.isDirectory()) {
      files.push(...await collectFiles(root, path))
    } else if (stats.isFile()) {
      files.push({
        path: relativePath,
        kind: 'file',
        bytes: stats.size,
        sha256: await hashFile(path),
        executable: process.platform === 'win32' ? relativePath.startsWith('bin/') : (stats.mode & 0o111) !== 0,
      })
    } else {
      fail(`Unsupported filesystem entry in Runtime resource tree: ${relativePath}`)
    }
  }
  return files
}

async function writeRuntimeManifest(root, { runtimeName, target, artifact, versions }) {
  const executableName = runtimeName === 'bun' ? 'bun' : 'node'
  const extension = target.os === 'Windows' ? '.exe' : ''
  const executableRelativePath = `bin/${executableName}${extension}`
  const manifestPath = join(root, 'desktop-runtime.json')
  const files = (await collectFiles(root)).filter((entry) => entry.path !== 'desktop-runtime.json')
  const manifest = {
    schema_version: 1,
    dsh: {
      package: versions.dsh.package,
      version: versions.dsh.version,
      source_commit: versions.dsh.commit,
      entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    },
    runtime: {
      name: runtimeName,
      version: artifact.version,
      status: runtimeName === 'bun' ? 'candidate-unverified' : 'pinned-node-baseline',
      executable: executableRelativePath,
      download_sha256: artifact.sha256,
      download_url: artifact.url,
    },
    target: { os: target.os, arch: target.arch, triple: target.triple },
    profile: 'profiles/cheapai.yml',
    runtime_entry: 'dist/src/index.js',
    files,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function replaceGeneratedDirectory(stage, destination) {
  await mkdir(dirname(destination), { recursive: true })
  let backup = null
  const current = await lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (current) {
    if (!current.isDirectory()) fail(`Refusing to replace a non-directory Runtime output: ${destination}`)
    try {
      JSON.parse(await readFile(join(destination, 'desktop-runtime.json'), 'utf8'))
    } catch {
      fail(`Refusing to replace an unrecognized Runtime output without desktop-runtime.json: ${destination}`)
    }
    backup = `${destination}.previous-${process.pid}`
    await rm(backup, { recursive: true, force: true })
    await rename(destination, backup)
  }
  try {
    await rename(stage, destination)
    if (backup) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (backup) await rename(backup, destination).catch(() => {})
    throw error
  }
}

async function prepare(options) {
  const versions = JSON.parse(await readFile(join(repositoryRoot, 'scripts/desktop/runtime-versions.json'), 'utf8'))
  const target = findTarget(versions, options.target)
  const host = hostTarget()
  if (host.triple !== target.triple) {
    fail(`Target ${target.triple} does not match this build host (${host.triple ?? `${host.os}-${host.arch}`}); prepare target-specific native dependencies on a matching runner`)
  }
  const artifact = findArtifact(versions, options.runtime, options.target)
  await mkdir(dirname(options.output), { recursive: true })
  const stage = await mkdtemp(join(dirname(options.output), `.runtime-stage-${process.pid}-`))
  try {
    const downloadedArchive = await downloadPinnedArtifact(artifact, options.runtime, options.target)
    const extractedDirectory = await mkdtemp(join(downloadCache, `.extract-${process.pid}-`))
    try {
      const extractedExecutable = await extractArtifact(downloadedArchive, artifact, extractedDirectory)
      await packageRuntime({
        repositoryRoot,
        outputDirectory: stage,
        targetTriple: options.target,
      })
      const runtimeName = options.runtime === 'bun' ? 'bun' : 'node'
      const binaryName = target.os === 'Windows' ? `${runtimeName}.exe` : runtimeName
      const binaryPath = join(stage, 'bin', binaryName)
      await mkdir(dirname(binaryPath), { recursive: true })
      await copyFile(extractedExecutable, binaryPath)
      if (target.os !== 'Windows') await chmod(binaryPath, 0o755)
      await writeRuntimeManifest(stage, {
        runtimeName: options.runtime,
        target,
        artifact,
        versions,
      })
      await replaceGeneratedDirectory(stage, options.output)
      process.stdout.write(`Prepared ${versions.dsh.package}@${versions.dsh.version} with ${options.runtime}@${artifact.version} for ${target.triple} at ${options.output}\n`)
    } finally {
      await rm(extractedDirectory, { recursive: true, force: true })
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await prepare(parseArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`Runtime preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
