#!/usr/bin/env node
'use strict'
// Test helper: writes an LTC test signal as a 16-bit WAV file.
//
//   node __test__/helpers/make-test-wav.js ltc.wav --fps 2997df --start 00:59:58;00 --seconds 10
//
// --jump <timecode> relocates halfway through; --channels 2 puts the LTC on
// the second channel of a stereo file.

const fs = require('node:fs')
const { parseArgs } = require('node:util')
const { FrameRate, _testing } = require('../..')
const { generateLtc } = _testing

// 16-bit PCM WAV from interleaved Int16Array samples.
function writeWav(samples, sampleRate, channels = 1) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const FPS = { 24: FrameRate.Fps24, 25: FrameRate.Fps25, '2997df': FrameRate.Fps2997Drop, 30: FrameRate.Fps30 }
const HZ = { 24: 24, 25: 25, '2997df': 30000 / 1001, 30: 30 }
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: 'string', default: '25' },
    start: { type: 'string', default: '01:00:00:00' },
    seconds: { type: 'string', default: '10' },
    jump: { type: 'string' },
    rate: { type: 'string', default: '48000' },
    channels: { type: 'string', default: '1' },
  },
})
const out = positionals[0]
if (!out || !FPS[o.fps]) {
  console.error('usage: make-test-wav.js <out.wav> [--fps 24|25|2997df|30] [--start TC] [--seconds N] [--jump TC] [--rate HZ] [--channels 1|2]')
  process.exit(2)
}
const sampleRate = Number(o.rate)
const frames = Math.round(Number(o.seconds) * HZ[o.fps])
const parts = o.jump
  ? [
      generateLtc({ sampleRate, frameRate: FPS[o.fps], start: o.start, frameCount: frames >> 1 }),
      generateLtc({ sampleRate, frameRate: FPS[o.fps], start: o.jump, frameCount: frames - (frames >> 1) }),
    ]
  : [generateLtc({ sampleRate, frameRate: FPS[o.fps], start: o.start, frameCount: frames })]
const mono = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
parts.reduce((at, p) => (mono.set(p, at), at + p.length), 0)
const channels = Number(o.channels)
const pcm = new Int16Array(mono.length * channels)
mono.forEach((s, i) => (pcm[i * channels + channels - 1] = s))
fs.writeFileSync(out, writeWav(pcm, sampleRate, channels))
console.log(`wrote ${out}: ${o.seconds} s of ${o.fps} fps LTC from ${o.start}${o.jump ? `, jumping to ${o.jump}` : ''}`)
