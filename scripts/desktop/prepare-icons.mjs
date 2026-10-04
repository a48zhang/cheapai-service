import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const sourceIcon = join(repositoryRoot, 'apps/desktop/src-tauri/icons/app.svg')
const iconsRoot = join(repositoryRoot, 'apps/desktop/src-tauri/icons')
const defaultOutput = join(iconsRoot, 'generated')
const stagingRoot = join(repositoryRoot, 'apps/desktop/.cache/icon-staging')
const requiredFiles = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico']

function fail(message) {
  throw new Error(message)
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function parseArgs(argv) {
  let output = defaultOutput
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--output') output = resolve(repositoryRoot, argv[++index] ?? '')
    else fail(`Unknown argument: ${arg}`)
    if (argv[index] === undefined || argv[index] === '') fail(`Missing value after ${arg}`)
  }
  if (!isInside(iconsRoot, output) || output === iconsRoot) {
    fail(`Generated icon output must be a directory inside ${iconsRoot}: ${output}`)
  }
  return output
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function inventory(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...await inventory(root, path))
    } else if (entry.isFile()) {
      const metadata = await lstat(path)
      files.push({
        path: relative(root, path).split(sep).join('/'),
        bytes: metadata.size,
        sha256: await sha256(path),
      })
    } else {
      fail(`Tauri icon generator produced an unsupported filesystem entry: ${path}`)
    }
  }
  return files
}

function runTauriIcon(cliScript, outputDirectory) {
  const result = spawnSync(process.execPath, [cliScript, 'icon', sourceIcon, '--output', outputDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) fail(`Could not start the pinned Tauri CLI: ${result.error.message}`)
  if (result.status !== 0) fail(`Pinned Tauri CLI icon generation failed with exit code ${result.status}`)
}

async function resolvePinnedCli() {
  const versions = JSON.parse(await readFile(join(repositoryRoot, 'scripts/desktop/runtime-versions.json'), 'utf8'))
  const packageDirectory = join(repositoryRoot, 'apps/desktop/node_modules/@tauri-apps/cli')
  const packageJson = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8').catch(() => {
    fail(`Pinned Tauri CLI is not installed at ${packageDirectory}; install the workspace dependencies before preparing icons`)
  }))
  const expectedVersion = versions.desktop.tauri.cli
  if (packageJson.version !== expectedVersion) {
    fail(`Tauri CLI version mismatch: expected ${expectedVersion}, found ${packageJson.version}`)
  }
  const cliScript = join(packageDirectory, 'tauri.js')
  const cliMetadata = await lstat(cliScript).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!cliMetadata?.isFile()) fail(`Pinned Tauri CLI entry is missing: ${cliScript}`)
  return cliScript
}

async function installGeneratedIcons(stage, output) {
  await mkdir(dirname(output), { recursive: true })
  let backup = null
  const current = await lstat(output).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (current) {
    if (!current.isDirectory()) fail(`Refusing to replace a non-directory icon output: ${output}`)
    try {
      JSON.parse(await readFile(join(output, 'desktop-icons.json'), 'utf8'))
    } catch {
      fail(`Refusing to replace unrecognized icon output without desktop-icons.json: ${output}`)
    }
    backup = `${output}.previous-${process.pid}`
    await rm(backup, { recursive: true, force: true })
    await rename(output, backup)
  }
  try {
    await rename(stage, output)
    if (backup) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (backup) await rename(backup, output).catch(() => {})
    throw error
  }
}

async function prepare(output) {
  const cliScript = await resolvePinnedCli()
  const cliVersion = JSON.parse(await readFile(join(repositoryRoot, 'scripts/desktop/runtime-versions.json'), 'utf8')).desktop.tauri.cli
  await mkdir(stagingRoot, { recursive: true })
  const stage = await mkdtemp(join(stagingRoot, `.generated-stage-${process.pid}-`))
  try {
    runTauriIcon(cliScript, stage)
    for (const name of requiredFiles) {
      const path = join(stage, name)
      const metadata = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!metadata?.isFile()) fail(`Pinned Tauri CLI did not generate required icon ${name}`)
    }
    const files = await inventory(stage)
    const manifest = {
      schema_version: 1,
      source: 'app.svg',
      tauri_cli: cliVersion,
      files,
    }
    await writeFile(join(stage, 'desktop-icons.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await installGeneratedIcons(stage, output)
    process.stdout.write(`Generated ${files.length} Tauri icon resources with CLI ${cliVersion} at ${output}\n`)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await prepare(parseArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`Icon preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
