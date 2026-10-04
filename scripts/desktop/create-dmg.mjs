import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ?? code})`))
    })
  })
}

/** Build a plain drag-to-Applications image without attaching a writable volume.
 * Tauri remains responsible for assembling the app. Only our unique staging
 * directory is removed; this command never detaches or modifies any disk.
 */
export async function createDmg({ app, output, volumeName }) {
  if (process.platform !== 'darwin') throw new Error('DMG creation requires macOS')
  const appPath = await realpath(app)
  if (!appPath.endsWith('.app') || !(await stat(appPath)).isDirectory()) {
    throw new Error('Expected an existing Tauri .app bundle')
  }
  await access(join(appPath, 'Contents/MacOS/sub2api-desktop'), constants.X_OK)
  await access(join(appPath, 'Contents/Info.plist'), constants.R_OK)
  const outputPath = resolve(output)
  if (!outputPath.endsWith('.dmg') || outputPath.startsWith(`${appPath}/`)) {
    throw new Error('DMG output must be outside the source app and end in .dmg')
  }
  if (typeof volumeName !== 'string' || !volumeName.trim() || /[\0\r\n/]/u.test(volumeName)) {
    throw new Error('Invalid DMG volume name')
  }
  await mkdir(dirname(outputPath), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputPath), '.dmg-stage-'))
  try {
    const source = join(staging, 'source')
    await mkdir(source)
    await run('/usr/bin/ditto', [appPath, join(source, basename(appPath))])
    await symlink('/Applications', join(source, 'Applications'))
    const image = join(staging, 'image.dmg')
    await run('/usr/bin/hdiutil', [
      'create', '-srcfolder', source, '-volname', volumeName,
      '-format', 'UDZO', image,
    ])
    await run('/usr/bin/hdiutil', ['verify', image])
    await rename(image, outputPath)
    process.stdout.write(`Verified DMG: ${outputPath}\n`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = { '--app': 'app', '--output': 'output', '--volume-name': 'volumeName' }[args[index]]
    if (!name || !args[index + 1] || options[name]) throw new Error('Expected --app, --output and --volume-name')
    options[name] = args[index + 1]
  }
  if (!options.app || !options.output || !options.volumeName) throw new Error('Expected --app, --output and --volume-name')
  createDmg(options).catch(error => {
    process.stderr.write(`DMG creation failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
