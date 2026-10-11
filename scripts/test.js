#!/usr/bin/env node
'use strict'
// Runs every __test__/*.test.js with the Node test runner. Lists the files
// itself, since shells on Windows do not expand globs and Node before 21
// does not either.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const dir = path.join(__dirname, '..', '__test__')
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f))
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
