'use strict'
// Runs the examples/timecode-cli sample on generated LTC and MTC input.
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cli = path.join(__dirname, '..', 'examples', 'timecode-cli')

test('timecode-cli reads a WAV file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timecode-cli-'))
  try {
    const wav = path.join(dir, 'ltc.wav')
    execFileSync(process.execPath, [
      path.join(__dirname, 'helpers', 'make-test-wav.js'), wav,
      '--fps', '2997df', '--start', '00:59:58;00', '--seconds', '6', '--jump', '10:00:00;00',
    ])
    const out = execFileSync(process.execPath, [cli, '--file', wav, '--fast'], { encoding: 'utf8' })
    const lines = out.trim().split('\n').map((l) => l.replace(/^\d\d:\d\d:\d\d\.\d{3}  /, ''))
    assert.deepEqual(lines, [
      'lock  00:59:58;03  29.97DF fps  channel 1',
      '00:59:58;03  29.97DF  LOCKED     -4 dBFS',
      '00:59:59;00  29.97DF  LOCKED     -4 dBFS',
      '01:00:00;00  29.97DF  LOCKED     -4 dBFS',
      'jump  10:00:00;01',
      '10:00:00;01  29.97DF  LOCKED     -4 dBFS',
      '10:00:01;00  29.97DF  LOCKED     -4 dBFS',
      '10:00:02;00  29.97DF  LOCKED     -4 dBFS',
      'lost',
      lines.at(-1),
    ])
    assert.match(lines.at(-1), /^--:--:--:--  --\s+(NO SIGNAL|SEARCHING)/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('timecode-cli reads MTC bytes from standard input', async () => {
  const { spawn } = require('node:child_process')
  const { FrameRate, _testing } = require('..')
  const stream = _testing.generateMtc({ frameRate: FrameRate.Fps25, start: '01:59:59:00', frameCount: 75 })
  const child = spawn(process.execPath, [cli, '--mtc'], { stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  // Send each quarter frame at its real time (3 seconds in all).
  const start = performance.now()
  for (let i = 0; i < stream.times.length; i++) {
    const wait = start + stream.times[i] - performance.now()
    if (wait > 1) await new Promise((r) => setTimeout(r, wait))
    child.stdin.write(stream.bytes.subarray(i * 2, i * 2 + 2))
  }
  child.stdin.end()
  await new Promise((r) => child.on('close', r))
  const lines = out.trim().split('\n').map((l) => l.replace(/^\d\d:\d\d:\d\d\.\d{3}  /, ''))
  assert.deepEqual(lines.slice(0, 5), [
    'lock  01:59:59:03  25 fps',
    '01:59:59:03  25       LOCKED     MTC',
    '02:00:00:00  25       LOCKED     MTC',
    '02:00:01:00  25       LOCKED     MTC',
    'lost',
  ])
})
