#!/usr/bin/env node
'use strict'
// timecode-cli: shows incoming LTC or MTC on one updating terminal line.
//
//   node examples/timecode-cli --file ltc.wav
//   ffmpeg -f avfoundation -i ":0" -ac 1 -ar 48000 -f s16le - | node examples/timecode-cli --rate 48000
//   node examples/timecode-cli --mtc --midi "IAC Driver Bus 1"
//
// It is also a sample of the stream-in design: every input is turned into an
// async iterable of chunks and handed to LtcReceiver/MtcReceiver.attach().

const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
const { parseArgs } = require('node:util')
const { readWav } = require('./wav.js')

let lib
try {
  lib = require('timecode-tools')
} catch {
  lib = require('../..') // running from a checkout
}
const { LtcReceiver, MtcReceiver, FrameRate } = lib

const USAGE = `Usage:
  timecode-cli --file <ltc.wav> [options]
  <pcm source> | timecode-cli --rate <hz> [--format s16le|f32le] [--channels <n>] [options]
  timecode-cli --mtc --midi <port> [options]
  <midi bytes> | timecode-cli --mtc [options]
  timecode-cli --list-midi

LTC input:
  --file <path>        Read a WAV file (16-bit, 24-bit or 32-bit float PCM)
  --fast               With --file: read as fast as possible, not in real time
  --rate <hz>          Sample rate of raw PCM on standard input
  --format <fmt>       Raw PCM format on standard input: s16le (default) or f32le
  --channels <n>       Interleaved channels in the input (default 1, or the WAV's)
  --channel <n>        Channel that carries LTC (1-based, default 1)

MTC input:
  --mtc                Read MIDI Time Code instead of LTC (raw MIDI bytes on
                       standard input, or a MIDI port with --midi)
  --midi <port>        MIDI input port, by name (or part of it) or number
  --list-midi          List MIDI input ports
  (--midi and --list-midi need the optional package @julusian/midi)

Decoding:
  --fps <rate>         auto (default), 24, 25, 2997df or 30
  --offset <frames>    Add this many frames to the timecode (latency correction)
  -h, --help           Show this help`

const FPS = {
  auto: FrameRate.Auto,
  24: FrameRate.Fps24,
  25: FrameRate.Fps25,
  '2997df': FrameRate.Fps2997Drop,
  30: FrameRate.Fps30,
}
const RATE_LABEL = { 24: '24', 25: '25', '29.97df': '29.97DF', 30: '30' }

function fail(message) {
  process.stderr.write(`timecode-cli: ${message}\n\n${USAGE}\n`)
  process.exit(2)
}

function integer(name, value, min, max) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer ${min}..${max}`)
  return n
}

const { values: args } = (() => {
  try {
    return parseArgs({
      options: {
        file: { type: 'string' },
        fast: { type: 'boolean' },
        rate: { type: 'string' },
        format: { type: 'string', default: 's16le' },
        channels: { type: 'string' },
        channel: { type: 'string' },
        mtc: { type: 'boolean' },
        midi: { type: 'string' },
        'list-midi': { type: 'boolean' },
        fps: { type: 'string', default: 'auto' },
        offset: { type: 'string', default: '0' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    fail(error.message)
  }
})()

if (args.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
const frameRate = FPS[args.fps]
if (!frameRate) fail('--fps must be one of auto, 24, 25, 2997df, 30')
const offsetFrames = integer('offset', args.offset, -86400 * 30, 86400 * 30)
const channel = integer('channel', args.channel, 1, 64)
if (!['s16le', 'f32le'].includes(args.format)) fail('--format must be s16le or f32le')

// WAV file -> 10 ms chunks, paced in real time unless --fast.
async function* fileChunks(path) {
  const wav = readWav(fs.readFileSync(path))
  const block = Math.round(wav.sampleRate / 100) * wav.channels
  const start = performance.now()
  for (let i = 0; i < wav.samples.length; i += block) {
    const at = (i / wav.channels / wav.sampleRate) * 1000
    if (!args.fast) {
      const wait = start + at - performance.now()
      if (wait > 1) await new Promise((r) => setTimeout(r, wait))
    }
    const samples = wav.samples.subarray(i, i + block)
    yield { samples, sampleRate: wav.sampleRate, channels: wav.channels, timestamp: start + at }
  }
}

// Raw PCM on standard input -> chunks. The arrival time stands in for the
// capture time, minus the duration of the block.
async function* stdinChunks(sampleRate, channels, format) {
  const bytesPerSample = format === 'f32le' ? 4 : 2
  const frameBytes = bytesPerSample * channels
  let rest = Buffer.alloc(0)
  for await (const data of process.stdin) {
    const now = performance.now()
    const buffer = rest.length ? Buffer.concat([rest, data]) : data
    const usable = buffer.length - (buffer.length % frameBytes)
    rest = Buffer.from(buffer.subarray(usable))
    if (usable === 0) continue
    const bytes = new Uint8Array(buffer.subarray(0, usable)) // copy, aligned
    const all =
      format === 'f32le' ? new Float32Array(bytes.buffer) : new Int16Array(bytes.buffer)
    const duration = (all.length / channels / sampleRate) * 1000
    yield { samples: all, sampleRate, channels, timestamp: now - duration }
  }
}

function loadMidi() {
  try {
    return require('@julusian/midi')
  } catch {
    fail('--midi and --list-midi need @julusian/midi: npm install @julusian/midi')
  }
}

function midiPorts(input) {
  return Array.from({ length: input.getPortCount() }, (_, i) => input.getPortName(i))
}

// MIDI input port -> chunks of `{ bytes, timestamp }`, one per message.
function midiChunks(portArg) {
  const midi = loadMidi()
  const input = new midi.Input()
  const ports = midiPorts(input)
  let index = /^\d+$/.test(portArg) ? Number(portArg) : ports.findIndex((p) => p.includes(portArg))
  if (!(index >= 0 && index < ports.length)) {
    fail(`no MIDI input matches ${JSON.stringify(portArg)}. Inputs: ${ports.join(', ') || '(none)'}`)
  }
  // Receive SysEx (full frames) and timing messages (quarter frames);
  // active sensing stays filtered.
  input.ignoreTypes(false, false, true)
  const queue = []
  let wake = null
  input.on('message', (_delta, message) => {
    queue.push({ bytes: Uint8Array.from(message), timestamp: performance.now() })
    if (wake) wake(), (wake = null)
  })
  input.openPort(index)
  process.stderr.write(`reading MTC from ${ports[index]}\n`)
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          while (queue.length) yield queue.shift()
          await new Promise((r) => (wake = r))
        }
      } finally {
        input.closePort()
      }
    },
  }
}

// Raw MIDI bytes on standard input, timestamped on arrival.
async function* stdinMidi() {
  for await (const data of process.stdin) yield { bytes: new Uint8Array(data), timestamp: performance.now() }
}

if (args['list-midi']) {
  const midi = loadMidi()
  const ports = midiPorts(new midi.Input())
  process.stdout.write(ports.length ? ports.map((p, i) => `${i}: ${p}`).join('\n') + '\n' : 'no MIDI inputs\n')
  process.exit(0)
}

let source
if (args.mtc) {
  if (args.file || args.rate) fail('--mtc reads MIDI, not audio: use --midi or standard input')
  if (args.midi) source = midiChunks(args.midi)
  else if (process.stdin.isTTY) fail('no input: use --midi <port>, or pipe raw MIDI bytes into standard input')
  else source = stdinMidi()
} else if (args.midi) {
  fail('--midi needs --mtc')
} else if (args.file) {
  if (args.rate) fail('--rate is for standard input; a WAV file has its own')
  source = fileChunks(args.file)
} else {
  if (process.stdin.isTTY) fail('no input: use --file, or pipe raw PCM into standard input')
  const rate = integer('rate', args.rate, 8000, 768000)
  if (!rate) fail('--rate is required for standard input')
  source = stdinChunks(rate, integer('channels', args.channels, 1, 64) ?? 1, args.format)
}

const rx = args.mtc
  ? new MtcReceiver({ frameRate, offsetFrames })
  : new LtcReceiver({ frameRate, offsetFrames, channel: channel ?? 1 })
const tty = process.stdout.isTTY
let current = null
let state = 'NO SIGNAL'

function dbfs() {
  if (args.mtc) return 'MTC'
  const level = rx.level
  return level > 0 ? `${Math.round(20 * Math.log10(level))} dBFS` : '-inf dBFS'
}

function statusLine() {
  const tc = current && rx.locked ? String(current) : '--:--:--:--'
  const rate = current && rx.locked ? RATE_LABEL[current.frameRate] : '--'
  const shown = rx.locked ? 'LOCKED' : state === 'LOCKED' ? 'NO SIGNAL' : state
  return `${tc}  ${rate.padEnd(7)}  ${shown.padEnd(9)}  ${dbfs()}`
}

function render() {
  if (tty) process.stdout.write(`\r${statusLine()}\x1b[K`)
}

// State changes are printed on their own line above the status line.
function log(text) {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  process.stdout.write(tty ? `\r\x1b[K${clock}  ${text}\n` : `${clock}  ${text}\n`)
  render()
}

async function watchEvents() {
  for await (const ev of rx.events({ buffer: 'all' })) {
    if (ev.type === 'lock') {
      state = 'LOCKED'
      log(`lock  ${ev.timecode}  ${RATE_LABEL[ev.frameRate]} fps${args.mtc ? '' : `  channel ${rx.channel}`}`)
    } else if (ev.type === 'jump') {
      log(`jump  ${ev.timecode}`)
    } else if (ev.type === 'lost') {
      state = 'NO SIGNAL'
      current = null
      log('lost')
    }
  }
}

let lastSecond = null

async function watchFrames() {
  // On a terminal, the default 'latest' buffer means a slow display never
  // falls behind. When writing to a file or pipe, take every frame.
  for await (const tc of rx.frames(tty ? undefined : { buffer: 'all' })) {
    current = tc
    render()
    // Without a terminal (piped to a file), print one line per second.
    const second = String(tc).slice(0, 8)
    if (!tty && second !== lastSecond) process.stdout.write(`${statusLine()}\n`)
    lastSecond = second
  }
}

rx.on('error', (error) => {
  process.stderr.write(`\ntimecode-cli: ${error.message}\n`)
  process.exitCode = 1
})
rx.once('end', () => {
  // Let the iterators drain, then finish.
  setImmediate(() => {
    if (tty) process.stdout.write(`\r${statusLine()}\x1b[K\n`)
    else process.stdout.write(`${statusLine()}\n`)
    process.exit()
  })
})
process.on('SIGINT', () => {
  rx.detach()
  if (tty) process.stdout.write('\n')
  process.exit(130)
})

// Repaint the level and "SEARCHING" state even without frames.
const timer = setInterval(() => {
  if (!rx.locked) state = !args.mtc && rx.level > 0.02 ? 'SEARCHING' : 'NO SIGNAL'
  render()
}, 100)
timer.unref()

watchEvents()
watchFrames()
rx.attach(source)
