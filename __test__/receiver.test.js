'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { LtcReceiver, FrameRate, _testing } = require('..')
const { generateLtc } = _testing

const RATE = 48000

function concat(...parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// Splits PCM into 10 ms chunks with timestamps from a fake monotonic clock.
function* chunks(pcm, { block = 480, t0 = 1000 } = {}) {
  for (let i = 0; i < pcm.length; i += block) {
    yield { samples: pcm.subarray(i, i + block), sampleRate: RATE, timestamp: t0 + (i / RATE) * 1000 }
  }
}

function record(rx) {
  const log = []
  rx.on('lock', (info) => log.push(`lock ${info.timecode} ${info.frameRate}`))
  rx.on('jump', (tc) => log.push(`jump ${tc}`))
  rx.on('lost', () => log.push('lost'))
  return log
}

test('lock, frames, jump and loss from pushed chunks', () => {
  const pcm = concat(
    generateLtc({ frameRate: FrameRate.Fps25, start: '01:00:00:00', frameCount: 40 }),
    generateLtc({ frameRate: FrameRate.Fps25, start: '02:00:00:00', frameCount: 40 }),
    new Int16Array(RATE),
  )
  const rx = new LtcReceiver()
  const log = record(rx)
  const frames = []
  rx.on('frame', (tc) => frames.push(String(tc)))
  for (const c of chunks(pcm)) rx._push(c)
  assert.deepEqual(log, ['lock 01:00:00:03 25', 'jump 02:00:00:01', 'lost'])
  assert.equal(frames[0], '01:00:00:03')
  assert.ok(frames.includes('01:00:01:14'))
  assert.equal(frames.at(-1), '02:00:01:14')
  assert.equal(rx.locked, false)
})

test('a single corrupt frame is ignored, not reported as a jump', () => {
  const a = generateLtc({ frameRate: FrameRate.Fps30, start: '00:10:00:00', frameCount: 20 })
  const glitch = generateLtc({ frameRate: FrameRate.Fps30, start: '05:00:00:00', frameCount: 1 })
  const b = generateLtc({ frameRate: FrameRate.Fps30, start: '00:10:00:21', frameCount: 20 })
  const rx = new LtcReceiver()
  const log = record(rx)
  const frames = []
  rx.on('frame', (tc) => frames.push(String(tc)))
  for (const c of chunks(concat(a, glitch, b))) rx._push(c)
  assert.deepEqual(log, ['lock 00:10:00:03 30'])
  assert.ok(!frames.some((f) => f.startsWith('05')))
  assert.equal(frames.at(-1), '00:10:01:10')
})

test('attach a Readable, waitFor a timecode, detach', async () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps2997Drop, start: '00:00:58;00', frameCount: 120 })
  const rx = new LtcReceiver({ frameRate: FrameRate.Auto })
  const log = record(rx)
  const passed = rx.waitFor('00:01:00;02')
  const never = rx.waitFor('10:00:00:00', { signal: AbortSignal.timeout(2000) })
  const ended = new Promise((resolve) => rx.once('end', resolve))
  rx.attach(Readable.from(chunks(pcm)))
  const tc = await passed
  assert.equal(String(tc), '00:01:00;02')
  assert.equal(tc.frameRate, FrameRate.Fps2997Drop)
  assert.ok(tc.timestamp > 1000)
  await ended
  assert.deepEqual(log, ['lock 00:00:58;03 29.97df', 'lost'])
  await assert.rejects(never)
  rx.detach()
})

test('waitFor resolves when passing the target between frames of a block', async () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps24, start: '00:59:59:00', frameCount: 60 })
  const rx = new LtcReceiver({ offsetFrames: 1 })
  const at = rx.waitFor('01:00:00:00')
  async function* source() {
    yield* chunks(pcm, { block: 4800 })
  }
  rx.attach(source())
  assert.equal(String(await at), '01:00:00:00')
  rx.detach()
})

test('detach stops reading and reports loss', async () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 50 })
  let pulled = 0
  async function* slow() {
    for (const c of chunks(pcm)) {
      pulled++
      yield c
      await new Promise((r) => setImmediate(r))
    }
  }
  const rx = new LtcReceiver()
  const log = record(rx)
  await new Promise((resolve) => {
    rx.once('lock', resolve)
    rx.attach(slow())
  })
  rx.detach()
  const at = pulled
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(pulled <= at + 1)
  assert.deepEqual(log.slice(-1), ['lost'])
  assert.throws(() => rx.attach({}), TypeError)
})

test('loss is reported when chunks stop arriving', async () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 20 })
  const rx = new LtcReceiver()
  for (const c of chunks(pcm)) rx._push(c)
  assert.equal(rx.locked, true)
  await new Promise((resolve) => rx.once('lost', resolve))
  assert.equal(rx.locked, false)
})

test('missing timestamps fall back to arrival time', () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 10 })
  const rx = new LtcReceiver()
  const stamps = []
  rx.on('frame', (tc) => stamps.push(tc.timestamp))
  rx._push({ samples: pcm, sampleRate: RATE })
  assert.ok(stamps.length > 0 && stamps.every((t) => Number.isFinite(t)))
})

test('stereo chunks: the LTC channel is selected', () => {
  const ltc = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 30 })
  const stereo = new Int16Array(ltc.length * 2)
  ltc.forEach((v, i) => (stereo[i * 2 + 1] = v))
  for (const [channel, want] of [
    [2, [null]],
    [1, []],
  ]) {
    const rx = new LtcReceiver({ channel })
    const locks = []
    rx.on('lock', (info) => locks.push(info.channel))
    for (let i = 0; i < stereo.length; i += 960) {
      rx._push({ samples: stereo.subarray(i, i + 960), sampleRate: RATE, channels: 2, timestamp: i / 96 })
    }
    assert.equal(locks.length, want.length)
    assert.equal(rx.channel, channel)
  }
})

test('addEventListener / removeEventListener deliver the same events', () => {
  const pcm = concat(
    generateLtc({ frameRate: FrameRate.Fps25, start: '01:00:00:00', frameCount: 30 }),
    generateLtc({ frameRate: FrameRate.Fps25, start: '03:00:00:00', frameCount: 30 }),
    new Int16Array(RATE),
  )
  const rx = new LtcReceiver()
  const seen = []
  const onFrame = (e) => seen.push(`frame ${e.detail}`)
  rx.addEventListener('frame', onFrame)
  rx.addEventListener('lock', (e) => seen.push(`lock ${e.detail.frameRate} ${e.type}`))
  rx.addEventListener('jump', { handleEvent: (e) => seen.push(`jump ${e.detail}`) })
  rx.addEventListener('lost', (e) => seen.push(`lost ${e.detail} ${e instanceof Event}`), { once: true })
  let i = 0
  for (const c of chunks(pcm)) {
    rx._push(c)
    if (++i === 40) rx.removeEventListener('frame', onFrame)
  }
  assert.equal(seen[0], 'lock 25 lock')
  assert.equal(seen[1], 'frame 01:00:00:03')
  assert.ok(seen.includes('jump 03:00:00:01'))
  assert.ok(!seen.some((s) => s.startsWith('frame 03')))
  assert.equal(seen.at(-1), 'lost undefined true')
  assert.equal(rx.listenerCount('frame'), 0)
  assert.equal(rx.listenerCount('lost'), 0)
})

test('frames() and events() as async iterators; break unsubscribes', async () => {
  const pcm = concat(
    generateLtc({ frameRate: FrameRate.Fps30, start: '00:00:10:00', frameCount: 30 }),
    generateLtc({ frameRate: FrameRate.Fps30, start: '00:20:00:00', frameCount: 30 }),
    new Int16Array(RATE),
  )
  const rx = new LtcReceiver()
  const all = []
  const events = []
  const allDone = (async () => {
    for await (const tc of rx.frames({ buffer: 'all' })) {
      all.push(String(tc))
      if (String(tc) === '00:20:00:20') break
    }
  })()
  const eventsDone = (async () => {
    for await (const ev of rx.events({ buffer: 'all' })) {
      events.push(ev.type === 'lost' ? ev.type : `${ev.type} ${ev.timecode}`)
      if (ev.type === 'lost') break
    }
  })()
  // A slow consumer with the default buffer gets the newest frame only.
  const latest = rx.frames()
  rx.attach(Readable.from(chunks(pcm)))
  await allDone
  await eventsDone
  assert.equal(all[0], '00:00:10:03')
  assert.equal(all.length, 27 + 20)
  assert.deepEqual(events, ['lock 00:00:10:03', 'jump 00:20:00:01', 'lost'])
  const first = await latest.next()
  assert.equal(String(first.value), '00:20:00:29')
  await latest.return()
  assert.equal(rx.listenerCount('frame'), 0)
  assert.equal(rx.listenerCount('lock'), 0)
  assert.throws(() => rx.frames({ buffer: 'some' }), TypeError)
})

test('an aborted signal ends an iterator', async () => {
  const rx = new LtcReceiver()
  const controller = new AbortController()
  const it = rx.frames({ signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  assert.equal((await it.next()).done, true)
  assert.equal(rx.listenerCount('frame'), 0)
})
