import { chmod } from 'node:fs/promises'
import { lstat, mkdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const FIXTURE_KIND = 'cheapai-desktop-runtime-fixture'
const FIXTURE_MARKER = '.cheapai-desktop-fixture.json'

function usage() {
  return [
    'Usage: node scripts/desktop/create-fixture.mjs --directory <new-temporary-directory>',
    'The directory must not exist and must be inside the operating system temporary directory.',
  ].join('\n')
}

function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument !== '--directory') throw new Error(`Unknown argument: ${argument}\n${usage()}`)
    if (options.directory !== undefined) throw new Error('--directory may be supplied only once')
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--directory requires a path\n${usage()}`)
    options.directory = value
    index += 1
  }
  if (!options.help && options.directory === undefined) throw new Error(usage())
  return options
}

function isWithin(directory, candidate) {
  const pathFromDirectory = relative(directory, candidate)
  return pathFromDirectory === ''
    || (pathFromDirectory !== '..'
      && !pathFromDirectory.startsWith(`..${sep}`)
      && !isAbsolute(pathFromDirectory))
}

async function canonicalNewDirectory(directoryArgument, temporaryRoot) {
  if (!isAbsolute(directoryArgument)) throw new Error('--directory must be an absolute path')
  const requestedPath = resolve(directoryArgument)
  const parentDirectory = await realpath(dirname(requestedPath))
  const directory = join(parentDirectory, basename(requestedPath))
  if (!isWithin(temporaryRoot, parentDirectory) || directory === temporaryRoot) {
    throw new Error(`Refusing to create a fixture outside the temporary directory: ${requestedPath}`)
  }
  try {
    await lstat(directory)
    throw new Error(`Refusing to overwrite an existing directory: ${requestedPath}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to overwrite')) throw error
    if (error?.code !== 'ENOENT') throw error
  }
  return directory
}

async function writeNewFile(path, contents, options = {}) {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', ...options })
}

async function createFixture(directory) {
  const workspace = join(directory, 'workspace')
  const fixtureId = randomUUID()
  const executableName = process.platform === 'win32' ? 'run-fixture.cmd' : 'run-fixture'
  const createdFiles = []
  let directoryCreated = false
  let workspaceCreated = false

  try {
    await mkdir(directory, { mode: 0o700 })
    directoryCreated = true
    await mkdir(workspace, { mode: 0o700 })
    workspaceCreated = true

    const readme = [
      'CheapAI desktop runtime fixture',
      '',
      'This workspace contains disposable local material for a desktop runtime exercise.',
      'It has no model credentials. The fixture creator never launches DSH or a model.',
      'The desktop dev launcher accepts this marked workspace and an isolated DSH home.',
      '',
    ].join('\n')
    const sample = [
      'A small paper boat crossed the quiet pond before the morning wind arrived.',
      'Its blue sail was folded from a note and its wooden hull came from a craft box.',
      'This sentence is only sample text in a temporary local workspace.',
      '',
    ].join('\n')
    const editable = [
      'fixture_status=original',
      'This file can be changed during an isolated desktop runtime exercise.',
      '',
    ].join('\n')
    const executable = process.platform === 'win32'
      ? '@echo off\r\necho cheapai desktop fixture ran\r\n'
      : '#!/bin/sh\nprintf \'%s\\n\' \'cheapai desktop fixture ran\'\n'

    const fixtureFiles = [
      ['README.md', readme],
      ['sample.txt', sample],
      ['change-me.txt', editable],
      [executableName, executable],
    ]
    for (const [name, contents] of fixtureFiles) {
      const path = join(workspace, name)
      await writeNewFile(path, contents, name === executableName ? { mode: 0o755 } : {})
      createdFiles.push(path)
      if (name === executableName && process.platform !== 'win32') await chmod(path, 0o755)
    }

    const markerPath = join(workspace, FIXTURE_MARKER)
    await writeNewFile(markerPath, `${JSON.stringify({ schema_version: 1, kind: FIXTURE_KIND, fixture_id: fixtureId }, null, 2)}\n`)
    createdFiles.push(markerPath)
  } catch (error) {
    for (const path of createdFiles.reverse()) await rm(path, { force: true }).catch(() => {})
    if (workspaceCreated) await rmdir(workspace).catch(() => {})
    if (directoryCreated) await rmdir(directory).catch(() => {})
    throw new Error(`Could not create the desktop fixture${directoryCreated ? ` at ${directory}` : ''}: ${error instanceof Error ? error.message : 'unknown filesystem error'}`, { cause: error })
  }

  return { fixtureId, workspace, executableName }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const temporaryRoot = await realpath(tmpdir())
  const directory = await canonicalNewDirectory(options.directory, temporaryRoot)
  const fixture = await createFixture(directory)
  process.stdout.write(`${JSON.stringify({
    fixtureDirectory: directory,
    workspaceDirectory: fixture.workspace,
    fixtureId: fixture.fixtureId,
    executable: join(fixture.workspace, fixture.executableName),
  })}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Could not create the desktop fixture'}\n`)
  process.exitCode = 1
})
