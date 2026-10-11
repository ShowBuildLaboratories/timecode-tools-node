#!/usr/bin/env node
'use strict'
// Checks that prebuilds/ holds a binary for every platform in package.json
// (napi.targets) and nothing else, before the package is packed for release.

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))

// Rust target triple -> file suffix used by native.js.
const SUFFIX = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'win32-x64-msvc',
  'aarch64-pc-windows-msvc': 'win32-arm64-msvc',
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'armv7-unknown-linux-gnueabihf': 'linux-arm-gnueabihf',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
}

const name = pkg.napi.binaryName
const want = pkg.napi.targets.map((t) => {
  if (!SUFFIX[t]) throw new Error(`unknown target ${t}`)
  return `${name}.${SUFFIX[t]}.node`
})
const dir = path.join(ROOT, 'prebuilds')
const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.node')) : []
const missing = want.filter((f) => !have.includes(f))
const extra = have.filter((f) => !want.includes(f))
for (const f of want.filter((f) => have.includes(f))) {
  console.log(`${f}  ${fs.statSync(path.join(dir, f)).size} bytes`)
}
if (missing.length || extra.length) {
  if (missing.length) console.error(`missing: ${missing.join(', ')}`)
  if (extra.length) console.error(`unexpected: ${extra.join(', ')}`)
  process.exit(1)
}
console.log(`all ${want.length} platform binaries present`)
