'use strict'
// Loads the prebuilt native module for this platform.
//
// All platform binaries ship inside this one package, in `prebuilds/`, named
// `timecode-tools.<platform>.node`. The module is opened with `process.dlopen`
// rather than `require`, so it still loads after a bundler (for example the
// esbuild step of `companion-module-build`) has rewritten `require` calls,
// as long as the `prebuilds/` folder is copied next to the bundle.

const fs = require('node:fs')
const path = require('node:path')

function isMusl() {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report && process.report.getReport()
    const header = report && (typeof report === 'string' ? JSON.parse(report) : report).header
    return !(header && header.glibcVersionRuntime)
  } catch {
    return false
  }
}

function platformSuffix() {
  const { platform, arch } = process
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `win32-${arch}-msvc`
  if (platform === 'linux') {
    if (arch === 'x64' || arch === 'arm64') return `linux-${arch}-${isMusl() ? 'musl' : 'gnu'}`
    if (arch === 'arm') return 'linux-arm-gnueabihf'
  }
  return null
}

function load() {
  const suffix = platformSuffix()
  if (!suffix) {
    throw new Error(`timecode-tools: no prebuilt binary for ${process.platform}-${process.arch}`)
  }
  const file = `timecode-tools.${suffix}.node`
  const candidates = [
    path.join(__dirname, 'prebuilds', file),
    path.join(__dirname, file),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = { exports: {} }
      process.dlopen(mod, candidate)
      return mod.exports
    }
  }
  throw new Error(
    `timecode-tools: ${file} not found (looked in ${candidates.join(', ')}). ` +
      'If you bundle this package, copy its prebuilds/ folder next to the bundle.',
  )
}

module.exports = load()
