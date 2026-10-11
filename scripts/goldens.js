#!/usr/bin/env node
'use strict'
// Keeps goldens/ an exact copy of the golden files in the Rust core
// repository (https://github.com/ShowBuildLaboratories/timecode-tools-rs,
// folder goldens/).
//
//   node scripts/goldens.js sync    copy the core's goldens/ here and write SHA256SUMS
//   node scripts/goldens.js check   verify goldens/ against SHA256SUMS and, when the
//                                   core checkout is present, against the core
//
// The core checkout is looked for in $TIMECODE_TOOLS_RS_DIR, else
// ../timecode-tools-rs. `check --require-core` fails when it is missing.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const LOCAL = path.join(ROOT, 'goldens')
const SUMS = 'SHA256SUMS'
// Files in goldens/ that this repository adds itself.
const OWN = new Set([SUMS])

function coreDir() {
  return path.resolve(process.env.TIMECODE_TOOLS_RS_DIR || path.join(ROOT, '..', 'timecode-tools-rs'))
}

// Relative paths (with '/') of every file under dir, sorted.
function listFiles(dir, skip = new Set()) {
  const out = []
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.name === '.DS_Store') continue
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile() && !skip.has(child)) out.push(child)
    }
  }
  walk('')
  return out.sort()
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readSums() {
  const file = path.join(LOCAL, SUMS)
  if (!fs.existsSync(file)) return null
  const sums = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (m) sums.set(m[2], m[1])
  }
  return sums
}

/** Differences between goldens/ and its SHA256SUMS. Empty when they agree. */
function checkSums() {
  const problems = []
  if (!fs.existsSync(LOCAL)) return ['goldens/ is missing']
  const sums = readSums()
  if (!sums) return [`goldens/${SUMS} is missing`]
  const files = listFiles(LOCAL, OWN)
  for (const f of files) {
    if (!sums.has(f)) problems.push(`goldens/${f} is not listed in ${SUMS}`)
    else if (sums.get(f) !== sha256(path.join(LOCAL, f))) problems.push(`goldens/${f} differs from ${SUMS}`)
  }
  for (const f of sums.keys()) if (!files.includes(f)) problems.push(`goldens/${f} is listed but missing`)
  if (sums.size === 0) problems.push(`${SUMS} lists no files`)
  return problems
}

/**
 * Differences between goldens/ and the core's goldens/. Returns null when
 * the core checkout is not present.
 */
function checkCore(dir = coreDir()) {
  const source = path.join(dir, 'goldens')
  if (!fs.existsSync(source)) return null
  const problems = []
  const want = listFiles(source)
  const have = listFiles(LOCAL, OWN)
  for (const f of want) {
    if (!have.includes(f)) problems.push(`goldens/${f} is missing (present in the core)`)
    else if (!fs.readFileSync(path.join(source, f)).equals(fs.readFileSync(path.join(LOCAL, f)))) {
      problems.push(`goldens/${f} differs from the core`)
    }
  }
  for (const f of have) if (!want.includes(f)) problems.push(`goldens/${f} is not in the core`)
  return problems
}

function sync(dir = coreDir()) {
  const source = path.join(dir, 'goldens')
  if (!fs.existsSync(source)) throw new Error(`no goldens/ in ${dir}; set TIMECODE_TOOLS_RS_DIR`)
  fs.rmSync(LOCAL, { recursive: true, force: true })
  const files = listFiles(source)
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(LOCAL, f)), { recursive: true })
    fs.copyFileSync(path.join(source, f), path.join(LOCAL, f))
  }
  const lines = files.map((f) => `${sha256(path.join(LOCAL, f))}  ${f}`)
  fs.writeFileSync(path.join(LOCAL, SUMS), lines.join('\n') + '\n')
  return files.length
}

module.exports = { checkSums, checkCore, sync, coreDir, LOCAL }

if (require.main === module) {
  const [command, ...flags] = process.argv.slice(2)
  if (command === 'sync') {
    const n = sync()
    console.log(`copied ${n} files from ${path.join(coreDir(), 'goldens')}`)
  } else if (command === 'check') {
    const problems = checkSums()
    const core = checkCore()
    if (core === null) {
      const msg = `no goldens/ in the core checkout at ${coreDir()}`
      if (flags.includes('--require-core')) problems.push(msg)
      else console.log(`${msg}; checked goldens/ against ${SUMS} only`)
    } else {
      problems.push(...core)
    }
    if (problems.length) {
      console.error(problems.join('\n'))
      process.exit(1)
    }
    console.log('goldens/ is up to date')
  } else {
    console.error('usage: goldens.js sync | check [--require-core]')
    process.exit(2)
  }
}
