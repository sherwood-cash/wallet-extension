/**
 * Produce the shippable Chrome Web Store package.
 *
 *   npm run zip
 *
 * Builds the extension, then zips the CONTENTS of dist/ into
 * dist-zip/sherwood-wallet-<version>.zip, with manifest.json at the zip's TOP LEVEL
 * (the Web Store rejects packages where the manifest is nested inside a folder). The
 * version is read from the built dist/manifest.json so the filename always matches the
 * artifact that ships.
 *
 * No heavy zip dependency is added. This shells out to the system `zip` when present,
 * and otherwise falls back to Python's stdlib `zipfile` (present on this and every
 * CI image we build on). Both paths add entries relative to dist/, which is what keeps
 * the manifest at the root.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')
const outDir = join(root, 'dist-zip')

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}

function has(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 1. Build.
console.log('› building…')
run('npm', ['run', 'build'])

if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error('✗ dist/manifest.json is missing after build — nothing to package.')
  process.exit(1)
}

// 2. Resolve version from the built manifest, so the filename matches what ships.
const version = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')).version
if (!version) {
  console.error('✗ dist/manifest.json has no "version".')
  process.exit(1)
}

// 3. Fresh output path.
mkdirSync(outDir, { recursive: true })
const zipPath = join(outDir, `sherwood-wallet-${version}.zip`)
rmSync(zipPath, { force: true })

// 4. Zip the CONTENTS of dist/ (manifest at the root). Both branches cwd into dist/ so
//    entry paths are relative — `zip -r . ` and Python's arcname both land files at top.
if (has('zip')) {
  run('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: distDir })
} else if (has('python3') || has('python')) {
  const py = has('python3') ? 'python3' : 'python'
  const script = [
    'import os, sys, zipfile',
    'src, out = sys.argv[1], sys.argv[2]',
    'z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)',
    'for base, _, files in os.walk(src):',
    '    for f in files:',
    '        full = os.path.join(base, f)',
    '        z.write(full, os.path.relpath(full, src))',
    'z.close()',
  ].join('\n')
  run(py, ['-c', script, distDir, zipPath])
} else {
  console.error('✗ Need either the `zip` binary or Python to package. Install one and retry.')
  process.exit(1)
}

console.log(`✓ wrote ${zipPath}`)
