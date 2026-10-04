import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '../..')

function fail(message) {
  throw new Error(message)
}

function packagePath(root, name) {
  return join(root, ...name.split('/'))
}

function requireLockfileImporters(lockfile, importers) {
  const entries = new Set(lockfile.split(/\r?\n/u))
  for (const importer of importers) {
    if (!entries.has(`  ${importer}:`)) {
      fail(`pnpm-lock.yaml does not contain the ${importer} workspace importer; refresh the desktop workspace lock before packaging`)
    }
  }
}

function inside(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function mapHost() {
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

function readTarget(versions, targetTriple) {
  const target = versions.targets.find((entry) => entry.triple === targetTriple)
  if (target) return target
  if (targetTriple === 'x86_64-unknown-linux-gnu') {
    return { os: 'Linux', arch: 'x64', triple: targetTriple }
  }
  fail(`Unsupported desktop target triple: ${targetTriple}`)
}

function validateTargetHost(target) {
  const host = mapHost()
  if (host.triple !== target.triple) {
    fail(`Target ${target.triple} does not match this build host (${host.triple ?? `${host.os}-${host.arch}`}); package native dependencies on a matching OS/architecture runner`)
  }
}

async function resolveDependency(importerDirectory, name) {
  const parts = name.split('/')
  let directory = importerDirectory
  for (;;) {
    const candidate = join(directory, 'node_modules', ...parts)
    try {
      const stats = await lstat(candidate)
      if (stats) {
        const resolved = await realpath(candidate)
        const metadata = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8'))
        if (metadata.name === name && metadata.version) return { source: resolved, metadata }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        if (error.code === 'ELOOP') fail(`Dependency symlink loop while resolving ${name} from ${importerDirectory}`)
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function dependencyEntries(metadata) {
  const optional = metadata.optionalDependencies ?? {}
  const peers = metadata.peerDependencies ?? {}
  const optionalPeers = new Set(
    Object.entries(metadata.peerDependenciesMeta ?? {})
      .filter(([, details]) => details?.optional === true)
      .map(([name]) => name),
  )
  const bundled = metadata.bundleDependencies ?? metadata.bundledDependencies ?? []
  const specs = new Map()
  for (const [name, range] of Object.entries(metadata.dependencies ?? {})) {
    specs.set(name, { range, optional: false })
  }
  for (const [name, range] of Object.entries(optional)) {
    specs.set(name, { range, optional: true })
  }
  for (const [name, range] of Object.entries(peers)) {
    if (!specs.has(name)) specs.set(name, { range, optional: optionalPeers.has(name) })
  }
  for (const name of bundled) {
    if (!specs.has(name)) specs.set(name, { range: '*', optional: false })
  }
  return specs
}

async function resolveRuntimeDependencies(runtimeDirectory, runtimePackage) {
  if (runtimePackage.dependencies === null
    || typeof runtimePackage.dependencies !== 'object'
    || Array.isArray(runtimePackage.dependencies)) {
    fail('Desktop Runtime package.json must declare production dependencies')
  }

  const dependencies = []
  for (const [name, specifier] of Object.entries(runtimePackage.dependencies)) {
    if (typeof specifier !== 'string' || specifier.length === 0) {
      fail(`Invalid production dependency specifier for ${name} in apps/desktop-runtime/package.json`)
    }
    const resolved = await resolveDependency(runtimeDirectory, name)
    if (!resolved) {
      fail(`Required Runtime production dependency ${name} (${specifier}) is not installed in the workspace dependency tree`)
    }
    if (resolved.metadata.name !== name || !resolved.metadata.version) {
      fail(`Resolved Runtime dependency ${name} has invalid package metadata at ${resolved.source}`)
    }
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(specifier)
      && resolved.metadata.version !== specifier) {
      fail(`Installed Runtime dependency mismatch for ${name}: expected ${specifier}, found ${resolved.metadata.version}`)
    }
    dependencies.push({ name, specifier, ...resolved })
  }
  return dependencies
}

async function copyRuntimeDependencies(dependencies, output, host) {
  // Discover the actual installed graph before choosing a portable Node layout.
  // A single resolved source can be shared at the root; distinct peer contexts
  // (even at the same version) must retain their own nested resolution.
  const visited = new Set()
  const sourcesByName = new Map()
  async function visit(dependency) {
    if (visited.has(dependency.source)) return
    visited.add(dependency.source)
    const sources = sourcesByName.get(dependency.name) ?? new Map()
    sources.set(dependency.source, dependency)
    sourcesByName.set(dependency.name, sources)
    for (const [name, spec] of dependencyEntries(dependency.metadata)) {
      const resolved = await resolveDependency(dependency.source, name)
      if (!resolved) {
        if (spec.optional) continue
        fail(`Required production dependency ${name} (${spec.range}) of ${dependency.name} is not installed`)
      }
      await visit({ name, ...resolved })
    }
  }
  for (const dependency of dependencies) await visit(dependency)
  const roots = new Map(dependencies.map(dependency => [dependency.name, dependency]))
  for (const [name, sources] of sourcesByName) {
    if (!roots.has(name) && sources.size === 1) roots.set(name, sources.values().next().value)
  }
  const visibleSources = new Map([...roots.values()].map(({ name, source }) => [name, source]))
  const destinationRoot = join(output, 'node_modules')
  for (const dependency of roots.values()) {
    await copyDependencyPackage({
      source: dependency.source,
      destination: packagePath(destinationRoot, dependency.name),
      metadata: dependency.metadata,
      visibleSources,
      active: new Set(),
      host,
    })
  }
}

async function copyPackageFiles(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const sourceRoot = await realpath(source)
  await cp(sourceRoot, destination, {
    recursive: true,
    dereference: true,
    filter: async (entry) => {
      const path = relative(sourceRoot, entry)
      if (!path) return true
      return !path.split(sep).includes('node_modules')
    },
  })
}

async function copyDependencyPackage({
  source,
  destination,
  metadata,
  visibleSources,
  active,
  host,
}) {
  const identity = `${metadata.name}@${metadata.version}`
  if (active.has(source)) return
  const existing = await lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing) {
    const installed = JSON.parse(await readFile(join(await realpath(destination), 'package.json'), 'utf8'))
    if (installed.name === metadata.name && installed.version === metadata.version) return
    fail(`Dependency layout conflict for ${metadata.name}: ${installed.version} and ${metadata.version} both required at ${destination}`)
  }

  const packageHost = metadata.os || metadata.cpu
  if (packageHost && !matchesHost(metadata, host)) {
    fail(`Resolved dependency ${identity} does not support target ${host.triple}`)
  }

  await copyPackageFiles(source, destination)
  const nextVisible = new Map(visibleSources)
  nextVisible.set(metadata.name, source)
  const nextActive = new Set(active)
  nextActive.add(source)
  const dependencies = []
  for (const [name, spec] of dependencyEntries(metadata)) {
    const resolved = await resolveDependency(source, name)
    if (!resolved) {
      if (spec.optional) continue
      fail(`Required production dependency ${name} (${spec.range}) of ${identity} is not installed in the workspace dependency tree`)
    }
    if (nextVisible.get(name) === resolved.source) continue
    dependencies.push({ name, source: resolved.source, metadata: resolved.metadata })
  }

  // Make this package's complete direct dependency set visible to every child.
  // This keeps compatible packages shared by normal Node resolution and nests
  // only sources that differ from an ancestor, including peer variants.
  const childVisible = new Map(nextVisible)
  for (const dependency of dependencies) childVisible.set(dependency.name, dependency.source)
  const dependencyRoot = join(destination, 'node_modules')
  for (const dependency of dependencies) {
    const childDestination = packagePath(dependencyRoot, dependency.name)
    await copyDependencyPackage({
      source: dependency.source,
      destination: childDestination,
      metadata: dependency.metadata,
      visibleSources: childVisible,
      active: nextActive,
      host,
    })
  }
}

function matchesHost(metadata, host) {
  const osNames = { macOS: ['darwin', 'macos'], Windows: ['win32', 'windows'], Linux: ['linux'] }
  const archNames = { x64: ['x64', 'x86_64'], arm64: ['arm64', 'aarch64'] }
  const os = osNames[host.os] ?? [host.os.toLowerCase()]
  const arch = archNames[host.arch] ?? [host.arch]
  const supportedOs = metadata.os
  const supportedCpu = metadata.cpu
  if (Array.isArray(supportedOs)) {
    const allowed = supportedOs.filter((entry) => !entry.startsWith('!'))
    const denied = supportedOs.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))
    if (denied.some((entry) => os.includes(entry))) return false
    if (allowed.length && !allowed.some((entry) => os.includes(entry))) return false
  }
  if (Array.isArray(supportedCpu)) {
    const allowed = supportedCpu.filter((entry) => !entry.startsWith('!'))
    const denied = supportedCpu.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))
    if (denied.some((entry) => arch.includes(entry))) return false
    if (allowed.length && !allowed.some((entry) => arch.includes(entry))) return false
  }
  return true
}

async function copyDirectory(source, destination, label) {
  let metadata
  try {
    metadata = await lstat(source)
  } catch {
    fail(`${label} is missing at ${source}. Build the desktop Runtime before preparing package resources.`)
  }
  if (!metadata.isDirectory()) fail(`${label} is not a directory: ${source}`)
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

async function copyDesktopNotices(root, output) {
  const notices = [
    ['THIRD_PARTY_NOTICES.md', 'notices/THIRD_PARTY_NOTICES.md'],
    ['LICENSES/desktop/DSH-MIT.txt', 'notices/LICENSES/desktop/DSH-MIT.txt'],
    ['LICENSES/desktop/Bun-LICENSE.md', 'notices/LICENSES/desktop/Bun-LICENSE.md'],
    ['LICENSES/desktop/Node-LICENSE.txt', 'notices/LICENSES/desktop/Node-LICENSE.txt'],
  ]
  for (const [sourceRelativePath, destinationRelativePath] of notices) {
    const source = join(root, sourceRelativePath)
    const metadata = await lstat(source).catch((error) => {
      if (error.code === 'ENOENT') fail(`Required desktop license or notice is missing: ${sourceRelativePath}`)
      throw error
    })
    if (!metadata.isFile()) fail(`Desktop license or notice is not a regular file: ${sourceRelativePath}`)
    const destination = join(output, ...destinationRelativePath.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
}

export async function packageRuntime({
  repositoryRoot = defaultRepositoryRoot,
  outputDirectory,
  targetTriple,
}) {
  if (!targetTriple) fail('A target Rust triple is required when packaging the Runtime')
  if (!outputDirectory) fail('An output directory is required when packaging the Runtime')
  const root = resolve(repositoryRoot)
  const output = resolve(root, outputDirectory)
  if (output === root || !inside(root, output)) fail(`Runtime output must stay inside the repository: ${output}`)

  const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') fail('pnpm-lock.yaml is missing; install and lock the desktop workspace before packaging')
    throw error
  })
  requireLockfileImporters(lockfile, [
    'apps/desktop',
    'apps/desktop-runtime',
    'packages/desktop-contracts',
  ])

  const versions = JSON.parse(await readFile(join(root, 'scripts/desktop/runtime-versions.json'), 'utf8'))
  const target = readTarget(versions, targetTriple)
  validateTargetHost(target)

  const runtimeDirectory = join(root, 'apps/desktop-runtime')
  const runtimePackage = JSON.parse(await readFile(join(runtimeDirectory, 'package.json'), 'utf8'))
  const runtimeDependencies = await resolveRuntimeDependencies(runtimeDirectory, runtimePackage)
  const dshPackageName = versions.dsh.package
  const dshDependency = runtimeDependencies.find(({ name }) => name === dshPackageName)
  if (!dshDependency || dshDependency.metadata.version !== versions.dsh.version) {
    fail(`Installed DSH package mismatch: expected ${dshPackageName}@${versions.dsh.version}, found ${dshDependency?.metadata.version ?? 'missing'}`)
  }

  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length > 0) {
    fail(`Runtime package output must be an empty staging directory: ${output}`)
  }
  await copyRuntimeDependencies(runtimeDependencies, output, target)

  const { dependencies: _dependencies, devDependencies: _devDependencies, scripts: _scripts, ...runtimeManifest } = runtimePackage
  await writeFile(join(output, 'package.json'), `${JSON.stringify({
    ...runtimeManifest,
    dependencies: Object.fromEntries(
      runtimeDependencies
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map(({ name, metadata }) => [name, metadata.version]),
    ),
  }, null, 2)}\n`)

  await copyDirectory(
    join(root, 'apps/desktop-runtime/dist'),
    join(output, 'dist'),
    'Compiled desktop Runtime output',
  )
  const runtimeEntry = join(output, 'dist/src/index.js')
  try {
    await lstat(runtimeEntry)
  } catch {
    fail(`Compiled Runtime entry is missing: ${runtimeEntry}; expected R06 output at dist/src/index.js`)
  }
  await mkdir(join(output, 'profiles'), { recursive: true })
  await cp(
    join(root, 'apps/desktop-runtime/profiles/cheapai.yml'),
    join(output, 'profiles/cheapai.yml'),
  )
  await copyDesktopNotices(root, output)

  return { outputDirectory: output, target }
}

async function main() {
  const args = process.argv.slice(2)
  let targetTriple
  let outputDirectory
  let repositoryRoot = defaultRepositoryRoot
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--target') targetTriple = args[++index]
    else if (arg === '--output') outputDirectory = args[++index]
    else if (arg === '--workspace-root') repositoryRoot = resolve(args[++index])
    else fail(`Unknown argument: ${arg}`)
    if (!args[index]) fail(`Missing value after ${arg}`)
  }
  if (!outputDirectory) fail('Usage: node scripts/desktop/package-runtime.mjs --target <Rust target triple> --output <directory>')
  const result = await packageRuntime({ repositoryRoot, outputDirectory, targetTriple })
  process.stdout.write(`Prepared DSH production dependency closure for ${result.target.triple} at ${result.outputDirectory}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Runtime packaging failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
