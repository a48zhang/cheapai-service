import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createReadStream } from 'node:fs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const resourceRoot = join(repositoryRoot, 'apps/desktop/src-tauri/resources/generated/runtime')

function fail(message) {
  throw new Error(message)
}

function inside(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function parseArgs(argv) {
  const options = { runtime: undefined, target: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--runtime') options.runtime = argv[++index]
    else if (arg === '--target') options.target = argv[++index]
    else fail(`Unknown argument: ${arg}`)
    if (!argv[index]) fail(`Missing value after ${arg}`)
  }
  if (!['node', 'bun'].includes(options.runtime) || !options.target) {
    fail('Usage: node scripts/desktop/release-manifest.mjs --runtime <node|bun> --target <Rust target triple>')
  }
  return options
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} is missing at ${path}`)
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON: ${path}`)
    throw error
  }
}

async function requireRegularFile(path, label, root = repositoryRoot) {
  const stats = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') fail(`${label} is missing at ${path}`)
    throw error
  })
  if (!stats.isFile()) fail(`${label} must be a regular file: ${path}`)
  const resolved = await realpath(path)
  if (!inside(await realpath(root), resolved)) fail(`${label} resolves outside its permitted directory: ${path}`)
  return stats
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function collectFiles(root, { skipReleaseManifest = false, runtimeInventory = false } = {}) {
  const files = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      const localPath = relative(root, path).split(sep).join('/')
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) fail(`Symbolic link in packaged resources is not supported: ${localPath}`)
      if (stats.isDirectory()) {
        await visit(path)
        continue
      }
      if (!stats.isFile()) fail(`Unsupported packaged resource type: ${localPath}`)
      if (skipReleaseManifest && localPath === 'release-manifest.json') continue
      const executable = process.platform === 'win32'
        ? localPath.startsWith('bin/')
        : (stats.mode & 0o111) !== 0
      files.push({
        path: localPath,
        kind: 'file',
        bytes: stats.size,
        sha256: await hashFile(path),
        ...(runtimeInventory ? { executable } : {}),
      })
    }
  }
  await visit(root)
  return files
}

async function collectDependencyPackages(runtimeRoot, target) {
  const packages = []
  const nodeModulesRoot = join(runtimeRoot, 'node_modules')

  async function readPackage(directory, expectedName) {
    const stats = await lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') fail(`Runtime dependency is missing: ${directory}`)
      throw error
    })
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`Runtime dependency is not a packaged directory: ${directory}`)
    const packagePath = join(directory, 'package.json')
    const packageStats = await requireRegularFile(packagePath, 'Runtime dependency package.json', runtimeRoot)
    const metadata = await readJson(packagePath, 'Runtime dependency package.json')
    if (metadata.name !== expectedName || typeof metadata.version !== 'string' || !metadata.version) {
      fail(`Invalid package identity at ${packagePath}; expected ${expectedName}`)
    }
    if (!supportsTarget(metadata, target)) {
      fail(`Packaged dependency ${metadata.name}@${metadata.version} does not support ${target.triple}`)
    }
    const packageRelativePath = relative(runtimeRoot, directory).split(sep).join('/')
    packages.push({
      name: metadata.name,
      version: metadata.version,
      path: packageRelativePath,
      ...(Array.isArray(metadata.os) ? { os: metadata.os } : {}),
      ...(Array.isArray(metadata.cpu) ? { cpu: metadata.cpu } : {}),
    })
    if (!packageStats.isFile()) fail(`Runtime dependency package.json is invalid: ${packagePath}`)
    const nestedModules = join(directory, 'node_modules')
    const nestedStats = await lstat(nestedModules).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (nestedStats) {
      if (!nestedStats.isDirectory() || nestedStats.isSymbolicLink()) fail(`Nested node_modules is not a packaged directory: ${nestedModules}`)
      await readNodeModules(nestedModules)
    }
  }

  async function readNodeModules(directory) {
    const stats = await lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') fail(`Runtime dependency closure is missing at ${directory}`)
      throw error
    })
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`node_modules is not a packaged directory: ${directory}`)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        const scopeStats = await lstat(entryPath)
        if (!scopeStats.isDirectory() || scopeStats.isSymbolicLink()) fail(`Invalid dependency scope directory: ${entryPath}`)
        const scopedEntries = await readdir(entryPath, { withFileTypes: true })
        scopedEntries.sort((left, right) => left.name.localeCompare(right.name))
        for (const scopedEntry of scopedEntries) {
          const packageName = `${entry.name}/${scopedEntry.name}`
          await readPackage(join(entryPath, scopedEntry.name), packageName)
        }
      } else {
        await readPackage(entryPath, entry.name)
      }
    }
  }

  await readNodeModules(nodeModulesRoot)
  packages.sort((left, right) => left.path.localeCompare(right.path))
  if (packages.length === 0) fail('Packaged Runtime contains no production dependency packages')
  return packages
}

function supportsTarget(metadata, target) {
  const osAliases = {
    macOS: ['darwin', 'macos'],
    Windows: ['win32', 'windows'],
    Linux: ['linux'],
  }
  const archAliases = {
    x64: ['x64', 'x86_64'],
    arm64: ['arm64', 'aarch64'],
  }
  return supportsConstraint(metadata.os, osAliases[target.os] ?? [target.os.toLowerCase()])
    && supportsConstraint(metadata.cpu, archAliases[target.arch] ?? [target.arch])
}

function supportsConstraint(specification, aliases) {
  if (specification === undefined) return true
  const constraints = Array.isArray(specification) ? specification : [specification]
  if (!constraints.every((item) => typeof item === 'string')) return false
  const normalizedAliases = aliases.map((item) => item.toLowerCase())
  const denied = constraints.filter((item) => item.startsWith('!')).map((item) => item.slice(1).toLowerCase())
  const allowed = constraints.filter((item) => !item.startsWith('!')).map((item) => item.toLowerCase())
  return !denied.some((item) => normalizedAliases.includes(item))
    && (!allowed.length || allowed.some((item) => normalizedAliases.includes(item)))
}

function targetFor(versions, triple) {
  const target = versions.targets?.find((entry) => entry.triple === triple)
  if (target) return target
  if (triple === 'x86_64-unknown-linux-gnu') return { os: 'Linux', arch: 'x64', triple }
  fail(`Unsupported desktop target triple: ${triple}`)
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

function gitOutput(args, label) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) fail(`Could not read ${label} with git: ${result.error.message}`)
  if (result.status !== 0) fail(`Could not read ${label} with git: ${(result.stderr || result.stdout || '').trim()}`)
  return result.stdout.trim()
}

function sourceCommit() {
  const commit = gitOutput(['rev-parse', '--verify', 'HEAD^{commit}'], 'source commit')
  if (!/^[a-f0-9]{40,64}$/iu.test(commit)) fail(`Git returned an invalid source commit: ${commit}`)
  const expected = process.env.GITHUB_SHA
  if (expected && expected.toLowerCase() !== commit.toLowerCase()) {
    fail(`GITHUB_SHA (${expected}) does not match the checked out source commit (${commit})`)
  }
  const dirtyFiles = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'], 'working tree status')
  if (dirtyFiles) fail('Release manifest generation requires a clean checkout so source_commit identifies the packaged sources')
  return commit.toLowerCase()
}

function cargoPackageVersion(cargoManifest) {
  const lines = cargoManifest.split(/\r?\n/u)
  const sectionStart = lines.indexOf('[package]')
  if (sectionStart < 0) fail('Cargo.toml is missing its [package] section')
  const sectionLines = []
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/u.test(lines[index])) break
    sectionLines.push(lines[index])
  }
  const section = sectionLines.join('\n')
  const version = section.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1]
  const name = section.match(/^name\s*=\s*"([^"]+)"\s*$/mu)?.[1]
  if (!name || !version) fail('Cargo.toml [package] must use literal name and version values for release manifest generation')
  return { name, version }
}

function requireLockImporter(lockfile, importer) {
  if (!lockfile.split(/\r?\n/u).includes(`  ${importer}:`)) {
    fail(`pnpm-lock.yaml does not contain the ${importer} workspace importer; refresh the desktop workspace lock before packaging`)
  }
}

async function verifyResourceRoot() {
  const stats = await lstat(resourceRoot).catch((error) => {
    if (error.code === 'ENOENT') fail(`Prepared Runtime resources are missing at ${resourceRoot}; prepare the target-specific package first`)
    throw error
  })
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`Prepared Runtime resource root is not a directory: ${resourceRoot}`)
  const resolved = await realpath(resourceRoot)
  if (!inside(await realpath(repositoryRoot), resolved)) fail(`Prepared Runtime resources resolve outside the repository: ${resourceRoot}`)
}

async function verifyDesktopNotices(runtimeFiles) {
  const notices = [
    ['THIRD_PARTY_NOTICES.md', 'notices/THIRD_PARTY_NOTICES.md'],
    ['LICENSES/desktop/DSH-MIT.txt', 'notices/LICENSES/desktop/DSH-MIT.txt'],
    ['LICENSES/desktop/Bun-LICENSE.md', 'notices/LICENSES/desktop/Bun-LICENSE.md'],
    ['LICENSES/desktop/Node-LICENSE.txt', 'notices/LICENSES/desktop/Node-LICENSE.txt'],
  ]
  const records = []
  for (const [sourceRelativePath, bundleRelativePath] of notices) {
    const source = join(repositoryRoot, sourceRelativePath)
    const bundled = join(resourceRoot, ...bundleRelativePath.split('/'))
    await requireRegularFile(source, 'Desktop source notice')
    await requireRegularFile(bundled, 'Packaged desktop notice', resourceRoot)
    const sourceHash = await hashFile(source)
    const bundledHash = await hashFile(bundled)
    if (sourceHash !== bundledHash) fail(`Packaged notice differs from its checked-in source: ${bundleRelativePath}`)
    const record = runtimeFiles.find((file) => file.path === bundleRelativePath)
    if (!record || record.sha256 !== sourceHash) fail(`Packaged notice is absent from the Runtime resource inventory: ${bundleRelativePath}`)
    records.push({ path: `resources/generated/runtime/${bundleRelativePath}`, bytes: record.bytes, sha256: record.sha256 })
  }
  return records
}

async function createManifest(options) {
  await verifyResourceRoot()
  const commit = sourceCommit()
  const versions = await readJson(join(repositoryRoot, 'scripts/desktop/runtime-versions.json'), 'Pinned desktop version file')
  if (versions.schema_version !== 1) fail('Unsupported scripts/desktop/runtime-versions.json schema_version')
  const target = targetFor(versions, options.target)
  const host = hostTarget()
  if (host.triple !== target.triple) {
    fail(`Target ${target.triple} does not match this build host (${host.triple ?? `${host.os}-${host.arch}`}); package target-specific native dependencies on a matching runner`)
  }

  const runtimePin = versions.runtimes?.[options.runtime]
  const artifact = runtimePin?.artifacts?.[target.triple]
  if (!runtimePin?.version || !artifact?.url || !/^[a-f0-9]{64}$/iu.test(artifact.sha256 ?? '')) {
    fail(`No complete pinned ${options.runtime} artifact exists for ${target.triple}`)
  }
  const artifactUrl = new URL(artifact.url)
  if (artifactUrl.protocol !== 'https:' || !['nodejs.org', 'github.com'].includes(artifactUrl.hostname)) {
    fail(`Pinned runtime artifact must use an official HTTPS host: ${artifact.url}`)
  }

  const desktopRoot = join(repositoryRoot, 'apps/desktop')
  const runtimeAppRoot = join(repositoryRoot, 'apps/desktop-runtime')
  const tauriRoot = join(desktopRoot, 'src-tauri')
  const desktopPackage = await readJson(join(desktopRoot, 'package.json'), 'Desktop frontend package manifest')
  const runtimePackage = await readJson(join(runtimeAppRoot, 'package.json'), 'Desktop Runtime package manifest')
  const tauriConfig = await readJson(join(tauriRoot, 'tauri.conf.json'), 'Tauri application configuration')
  const cargoManifest = await readFile(join(tauriRoot, 'Cargo.toml'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') fail('Tauri Cargo.toml is missing')
    throw error
  })
  const cargoPackage = cargoPackageVersion(cargoManifest)
  const versionsInApp = {
    native_shell: cargoPackage.version,
    tauri_bundle: tauriConfig.version,
    frontend: desktopPackage.version,
    runtime_application: runtimePackage.version,
  }
  const uniqueAppVersions = new Set(Object.values(versionsInApp))
  if (uniqueAppVersions.size !== 1 || [...uniqueAppVersions][0] === undefined) {
    fail(`Desktop shell, Tauri bundle, frontend, and Runtime versions must match; found ${JSON.stringify(versionsInApp)}`)
  }
  if (typeof tauriConfig.productName !== 'string' || typeof tauriConfig.identifier !== 'string') {
    fail('Tauri productName and identifier are required for the release manifest')
  }
  if (tauriConfig.bundle?.resources?.includes('resources/generated/runtime/**/*') !== true) {
    fail('Tauri bundle.resources must include resources/generated/runtime/**/*')
  }

  const lockfilePath = join(repositoryRoot, 'pnpm-lock.yaml')
  const lockfile = await readFile(lockfilePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') fail('pnpm-lock.yaml is missing; install and lock the desktop workspace before packaging')
    throw error
  })
  for (const importer of ['apps/desktop', 'apps/desktop-runtime', 'packages/desktop-contracts']) {
    requireLockImporter(lockfile, importer)
  }
  const cargoLockPath = join(tauriRoot, 'Cargo.lock')
  await requireRegularFile(cargoLockPath, 'Tauri Cargo.lock')

  const desktopRuntime = await readJson(join(resourceRoot, 'desktop-runtime.json'), 'Prepared desktop-runtime.json')
  if (desktopRuntime.schema_version !== 1) fail('Unsupported desktop-runtime.json schema_version')
  if (desktopRuntime.target?.triple !== target.triple
    || desktopRuntime.target?.os !== target.os
    || desktopRuntime.target?.arch !== target.arch) {
    fail(`Prepared Runtime target does not match ${target.triple}`)
  }
  const expectedRuntimeExecutable = `bin/${options.runtime}${target.os === 'Windows' ? '.exe' : ''}`
  if (desktopRuntime.runtime?.name !== options.runtime
    || desktopRuntime.runtime?.version !== runtimePin.version
    || desktopRuntime.runtime?.executable !== expectedRuntimeExecutable
    || desktopRuntime.runtime?.download_url !== artifact.url
    || desktopRuntime.runtime?.download_sha256?.toLowerCase() !== artifact.sha256.toLowerCase()) {
    fail(`Prepared Runtime does not match the pinned ${options.runtime}@${runtimePin.version} artifact for ${target.triple}`)
  }
  const dshPin = versions.dsh
  if (desktopRuntime.dsh?.package !== dshPin.package
    || desktopRuntime.dsh?.version !== dshPin.version
    || desktopRuntime.dsh?.source_commit !== dshPin.commit) {
    fail('Prepared Runtime DSH package/version/source commit does not match scripts/desktop/runtime-versions.json')
  }
  if (desktopRuntime.dsh?.entry !== 'node_modules/@deepseek-ai/dsh/lib/bin.js'
    || desktopRuntime.runtime_entry !== 'dist/src/index.js'
    || desktopRuntime.profile !== 'profiles/cheapai.yml') {
    fail('Prepared Runtime entry points do not match the desktop runtime contract')
  }

  const runtimeInventory = await collectFiles(resourceRoot, { skipReleaseManifest: true, runtimeInventory: true })
  if (!Array.isArray(desktopRuntime.files)) fail('Prepared desktop-runtime.json has no resource inventory')
  const expectedRuntimeInventory = runtimeInventory.filter((file) => file.path !== 'desktop-runtime.json')
  if (JSON.stringify(desktopRuntime.files) !== JSON.stringify(expectedRuntimeInventory)) {
    fail('Prepared desktop-runtime.json resource hashes no longer match the packaged Runtime files')
  }
  const requiredPaths = [
    desktopRuntime.runtime.executable,
    desktopRuntime.dsh.entry,
    desktopRuntime.runtime_entry,
    desktopRuntime.profile,
  ]
  for (const resourcePath of requiredPaths) {
    if (!runtimeInventory.some((file) => file.path === resourcePath)) fail(`Required Runtime resource is missing: ${resourcePath}`)
  }
  const bundledRuntimePackage = await readJson(join(resourceRoot, 'package.json'), 'Packaged Runtime package manifest')
  if (bundledRuntimePackage.name !== runtimePackage.name || bundledRuntimePackage.version !== runtimePackage.version) {
    fail('Packaged Runtime application package name/version does not match its source package manifest')
  }

  const dependencyPackages = await collectDependencyPackages(resourceRoot, target)
  const dshDependency = dependencyPackages.find((dependency) => dependency.name === dshPin.package
    && dependency.version === dshPin.version)
  if (!dshDependency) fail(`Packaged dependency closure does not contain ${dshPin.package}@${dshPin.version}`)
  const directDependencies = bundledRuntimePackage.dependencies
  if (!directDependencies || typeof directDependencies !== 'object' || Array.isArray(directDependencies)) {
    fail('Packaged Runtime package manifest has no production dependency map')
  }
  for (const [name, version] of Object.entries(directDependencies)) {
    const rootPath = `node_modules/${name}`
    if (!dependencyPackages.some((dependency) => dependency.path === rootPath
      && dependency.name === name && dependency.version === version)) {
      fail(`Packaged direct Runtime dependency is absent or mismatched: ${name}@${version}`)
    }
  }

  const tauriFrontendDist = tauriConfig.build?.frontendDist
  if (typeof tauriFrontendDist !== 'string' || !tauriFrontendDist) fail('Tauri build.frontendDist is required')
  const frontendRoot = resolve(tauriRoot, tauriFrontendDist)
  if (!inside(repositoryRoot, frontendRoot)) fail(`Tauri frontendDist resolves outside the repository: ${tauriFrontendDist}`)
  const frontendStats = await lstat(frontendRoot).catch((error) => {
    if (error.code === 'ENOENT') fail(`Built desktop frontend is missing at ${frontendRoot}; build the frontend before generating the release manifest`)
    throw error
  })
  if (!frontendStats.isDirectory() || frontendStats.isSymbolicLink()) fail(`Built desktop frontend is not a directory: ${frontendRoot}`)
  const frontendFiles = await collectFiles(frontendRoot)
  if (!frontendFiles.some((file) => file.path === 'index.html')) fail('Built desktop frontend is missing index.html')

  const notices = await verifyDesktopNotices(runtimeInventory)
  const npmLicenseFiles = runtimeInventory
    .filter((file) => file.path.startsWith('node_modules/'))
    .filter((file) => /^(?:licen[cs]es?|notice|copying)(?:[._-].*)?$/iu.test(file.path.slice(file.path.lastIndexOf('/') + 1)))
    .map((file) => ({
      path: `resources/generated/runtime/${file.path}`,
      bytes: file.bytes,
      sha256: file.sha256,
    }))
  const nativeAddons = runtimeInventory
    .filter((file) => file.path.startsWith('node_modules/') && file.path.toLowerCase().endsWith('.node'))
    .map((file) => ({
      path: `resources/generated/runtime/${file.path}`,
      bytes: file.bytes,
      sha256: file.sha256,
    }))
  const packageGroups = new Map()
  for (const dependency of dependencyPackages) {
    const identity = `${dependency.name}\0${dependency.version}`
    const group = packageGroups.get(identity) ?? {
      name: dependency.name,
      version: dependency.version,
      paths: [],
      ...(dependency.os ? { os: dependency.os } : {}),
      ...(dependency.cpu ? { cpu: dependency.cpu } : {}),
    }
    group.paths.push(dependency.path)
    packageGroups.set(identity, group)
  }
  const dependencyClosure = [...packageGroups.values()]
    .map((group) => ({ ...group, paths: group.paths.sort() }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))

  const manifestPath = join(resourceRoot, 'release-manifest.json')
  const existingManifest = await lstat(manifestPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (existingManifest && (!existingManifest.isFile() || existingManifest.isSymbolicLink())) {
    fail(`Refusing to replace a non-file release manifest path: ${manifestPath}`)
  }
  const manifest = {
    schema_version: 1,
    manifest_path: 'resources/generated/runtime/release-manifest.json',
    source: {
      commit,
      pnpm_lock: {
        path: 'pnpm-lock.yaml',
        sha256: await hashFile(lockfilePath),
      },
      cargo_lock: {
        path: 'apps/desktop/src-tauri/Cargo.lock',
        sha256: await hashFile(cargoLockPath),
      },
    },
    application: {
      name: tauriConfig.productName,
      identifier: tauriConfig.identifier,
      version: desktopPackage.version,
      versions: versionsInApp,
    },
    target,
    dsh: {
      package: dshPin.package,
      version: dshPin.version,
      source_commit: dshPin.commit,
      entry: desktopRuntime.dsh.entry,
    },
    runtime: {
      name: options.runtime,
      version: runtimePin.version,
      status: runtimePin.role ?? 'pinned',
      executable: `resources/generated/runtime/${desktopRuntime.runtime.executable}`,
      entry: `resources/generated/runtime/${desktopRuntime.runtime_entry}`,
      artifact: {
        url: artifact.url,
        sha256: artifact.sha256.toLowerCase(),
      },
    },
    dependency_closure: {
      instance_count: dependencyPackages.length,
      packages: dependencyClosure,
      native_addons: nativeAddons,
    },
    third_party_notices: {
      desktop: notices,
      npm: npmLicenseFiles,
    },
    resources: {
      frontend_dist: {
        source: relative(repositoryRoot, frontendRoot).split(sep).join('/'),
        files: frontendFiles,
      },
      tauri_resources: {
        source: 'apps/desktop/src-tauri/resources/generated/runtime',
        bundle_glob: 'resources/generated/runtime/**/*',
        files: runtimeInventory.map((file) => ({
          ...file,
          path: `resources/generated/runtime/${file.path}`,
        })),
      },
    },
  }

  const temporaryPath = `${manifestPath}.tmp-${process.pid}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, manifestPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  process.stdout.write(`Wrote release manifest for ${options.runtime}@${runtimePin.version}, ${dshPin.package}@${dshPin.version}, ${target.triple}, app ${desktopPackage.version} at ${manifestPath}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await createManifest(parseArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`Desktop release manifest failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
