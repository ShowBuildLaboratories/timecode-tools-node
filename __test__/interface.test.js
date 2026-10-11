'use strict'
// LtcReceiver and MtcReceiver behave the same through TimecodeReceiver.
const test = require('node:test')
const assert = require('node:assert/strict')
const { TimecodeReceiver, LtcReceiver, MtcReceiver, FrameRate, _testing } = require('..')
const { generateLtc, generateMtc } = _testing

async function* ltcChunks() {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, start: '00:59:59:00', frameCount: 60 })
  for (let i = 0; i < pcm.length; i += 480) {
    yield { samples: pcm.subarray(i, i + 480), sampleRate: 48000, timestamp: (i / 48000) * 1000 }
  }
}

async function* mtcChunks() {
  const s = generateMtc({ frameRate: FrameRate.Fps25, start: '00:59:59:00', frameCount: 60 })
  for (let i = 0; i < s.times.length; i++) yield { bytes: s.bytes.subarray(i * 2, i * 2 + 2), timestamp: s.times[i] }
}

// Written once against the shared interface.
async function follow(rx, source) {
  assert.ok(rx instanceof TimecodeReceiver)
  const log = []
  rx.on('lock', ({ frameRate }) => log.push(`lock ${frameRate}`))
  rx.on('lost', () => log.push('lost'))
  const passed = rx.waitFor('01:00:00:10')
  rx.attach(source)
  log.push(`passed ${await passed}`)
  await new Promise((resolve) => rx.once('end', resolve))
  return log
}

test('the same code follows LTC and MTC', async () => {
  assert.deepEqual(await follow(new LtcReceiver(), ltcChunks()), ['lock 25', 'passed 01:00:00:10', 'lost'])
  assert.deepEqual(await follow(new MtcReceiver(), mtcChunks()), ['lock 25', 'passed 01:00:00:10', 'lost'])
  assert.throws(() => new TimecodeReceiver({}), TypeError)
})

test('offsetFrames can be read and changed', () => {
  for (const rx of [new LtcReceiver({ offsetFrames: -2 }), new MtcReceiver({ offsetFrames: -2 })]) {
    assert.equal(rx.offsetFrames, -2)
    rx.offsetFrames = 3
    assert.equal(rx.offsetFrames, 3)
    assert.throws(() => (rx.offsetFrames = 1.5), RangeError)
  }
  const rx = new LtcReceiver({ offsetFrames: 0 })
  const frames = []
  rx.on('frame', (tc) => frames.push(String(tc)))
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 20 })
  rx._push({ samples: pcm.subarray(0, 19200), sampleRate: 48000, timestamp: 0 })
  rx.offsetFrames = 100
  rx._push({ samples: pcm.subarray(19200), sampleRate: 48000, timestamp: 400 })
  // The shift appears as a jump once confirmed, not as a stray frame.
  rx.on('jump', () => {})
  assert.equal(frames[5], '00:00:00:08')
  assert.equal(frames[6], '00:00:04:10')
  assert.equal(frames.at(-1), '00:00:04:19')
})

test('close() ends iterators, rejects waiters and stops input', async () => {
  for (const rx of [new LtcReceiver(), new MtcReceiver()]) {
    const it = rx.frames()
    const ev = rx.events({ buffer: 'all' })
    const waiting = rx.waitFor('10:00:00:00')
    rx.close()
    assert.equal((await it.next()).done, true)
    assert.equal((await ev.next()).done, true)
    await assert.rejects(waiting, /closed/)
    await assert.rejects(rx.waitFor('10:00:00:00'), /closed/)
    assert.throws(() => rx._push(new Uint8Array(2)), /closed/)
    assert.throws(() => rx.attach(ltcChunks()), /closed/)
    assert.equal(rx.closed, true)
    assert.equal(rx.listenerCount('frame'), 0)
    rx.close() // idempotent
  }
})

test('close() while locked reports lost', () => {
  const rx = new LtcReceiver()
  const log = []
  rx.on('lost', () => log.push('lost'))
  rx._push({ samples: generateLtc({ frameCount: 20 }), sampleRate: 48000, timestamp: 0 })
  assert.equal(rx.locked, true)
  rx.close()
  assert.deepEqual(log, ['lost'])
})

test('events() yields end, and throws on an input error', async () => {
  const rx = new LtcReceiver()
  const seen = []
  const it = (async () => {
    for await (const ev of rx.events({ buffer: 'all' })) seen.push(ev.type)
  })()
  rx.attach(ltcChunks())
  await new Promise((resolve) => rx.once('end', resolve))
  await new Promise((resolve) => setImmediate(resolve)) // let the loop catch up
  assert.deepEqual(seen, ['lock', 'lost', 'end'])
  async function* failing() {
    yield* ltcChunks()
    throw new Error('device unplugged')
  }
  const failed = assert.rejects(it, /device unplugged/)
  rx.attach(failing())
  await failed
  assert.deepEqual(seen.slice(3), ['lock'])
  rx.close()
})
