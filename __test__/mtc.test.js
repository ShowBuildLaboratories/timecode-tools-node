'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { MtcReceiver, FrameRate, Timecode, _testing } = require('..')
const { generateMtc, mtcFullFrame } = _testing

// One chunk per quarter-frame message, timestamped like a MIDI API would.
function* messages(stream, t0 = 1000, wrap = (bytes, t) => ({ bytes: bytes, timestamp: t })) {
  for (let i = 0; i < stream.times.length; i++) {
    yield wrap(stream.bytes.subarray(i * 2, i * 2 + 2), t0 + stream.times[i])
  }
}

function record(rx) {
  const log = []
  rx.on('lock', (i) => log.push(`lock ${i.timecode} ${i.frameRate}`))
  rx.on('jump', (tc) => log.push(`jump ${tc}`))
  rx.on('lost', () => log.push('lost'))
  return log
}

for (const [frameRate, start, first] of [
  [FrameRate.Fps24, '01:00:00:00', '01:00:00:03'],
  [FrameRate.Fps25, '10:59:59:20', '10:59:59:23'],
  [FrameRate.Fps2997Drop, '00:00:59;26', '00:00:59;29'],
  [FrameRate.Fps30, '23:59:59:26', '23:59:59:29'],
]) {
  test(`one frame per frame from quarter frames at ${frameRate}`, () => {
    const stream = generateMtc({ frameRate, start, frameCount: 40 })
    const rx = new MtcReceiver()
    const log = record(rx)
    const frames = []
    rx.on('frame', (tc) => frames.push(tc))
    for (const m of messages(stream)) rx._push(m)
    assert.deepEqual(log, [`lock ${first} ${frameRate}`])
    // 40 frames give 39 readings, of which 2 come before the lock.
    assert.equal(frames.length, 37)
    assert.equal(String(frames[0]), first)
    const day = Timecode.fromFrameIndex(-1, frameRate).frameIndex() + 1
    const period = 1000 / { 24: 24, 25: 25, '29.97df': 30000 / 1001, 30: 30 }[frameRate]
    for (let i = 1; i < frames.length; i++) {
      assert.equal((frames[i].frameIndex() - frames[i - 1].frameIndex() + day) % day, 1)
      assert.ok(Math.abs(frames[i].timestamp - frames[i - 1].timestamp - period) < 0.01)
    }
    assert.equal(rx.detectedRate, frameRate)
  })
}

test('mixed MIDI traffic, Buffers and byte arrays', () => {
  const stream = generateMtc({ frameRate: FrameRate.Fps25, start: '02:00:00:00', frameCount: 8 })
  const noisy = []
  for (let i = 0; i < stream.times.length; i++) {
    noisy.push([0xf8, 0x90, 64, 100, 65, 0, stream.bytes[i * 2], 0xfe, stream.bytes[i * 2 + 1]])
  }
  for (const form of [(b) => b, (b) => Buffer.from(b), (b) => Uint8Array.from(b)]) {
    const rx = new MtcReceiver()
    const frames = []
    rx.on('frame', (tc) => frames.push(String(tc)))
    noisy.forEach((b, i) => rx._push({ bytes: form(b), timestamp: stream.times[i] }))
    assert.deepEqual(frames, ['02:00:00:03', '02:00:00:04', '02:00:00:05', '02:00:00:06', '02:00:00:07'])
  }
})

test('locate by full frame, relocate, stop', () => {
  const rx = new MtcReceiver()
  const log = record(rx)
  const frames = []
  rx.on('frame', (tc) => frames.push(String(tc)))
  for (const m of messages(generateMtc({ frameRate: FrameRate.Fps30, start: '00:00:58:00', frameCount: 30 }))) {
    rx._push(m)
  }
  // Locate while running: the chase ends and the new position is a jump.
  rx._push({ bytes: mtcFullFrame('05:00:00:00', FrameRate.Fps30), timestamp: 5000 })
  assert.equal(String(rx.current), '05:00:00:00')
  for (const m of messages(generateMtc({ frameRate: FrameRate.Fps30, start: '05:00:00:00', frameCount: 30 }), 6000)) {
    rx._push(m)
  }
  // A relocation during playback (no full frame) is a jump; the chase goes on.
  for (const m of messages(generateMtc({ frameRate: FrameRate.Fps30, start: '07:00:00:00', frameCount: 30 }), 7000)) {
    rx._push(m)
  }
  rx._push({ bytes: [0xf8], timestamp: 9000 })
  assert.deepEqual(log, [
    'lock 00:00:58:03 30',
    'lost',
    'jump 05:00:00:00',
    'lock 05:00:00:03 30',
    'jump 07:00:00:02',
    'lost',
  ])
  assert.equal(frames[0], '00:00:58:03')
  assert.equal(frames.at(-1), '07:00:00:29')
})

test('attach a byte stream, waitFor, iterate', async () => {
  const stream = generateMtc({ frameRate: FrameRate.Fps25, start: '00:10:00:00', frameCount: 50 })
  const rx = new MtcReceiver({ offsetFrames: 2 })
  const got = []
  const done = (async () => {
    for await (const tc of rx.frames({ buffer: 'all' })) {
      got.push(String(tc))
      if (got.length === 3) break
    }
  })()
  const events = []
  rx.addEventListener('lock', (e) => events.push(e.detail.frameRate))
  const passed = rx.waitFor('00:10:01:00')
  rx.attach(Readable.from(messages(stream)))
  await done
  assert.deepEqual(got, ['00:10:00:05', '00:10:00:06', '00:10:00:07'])
  assert.equal(String(await passed), '00:10:01:00')
  assert.deepEqual(events, ['25'])
  rx.detach()
  assert.throws(() => rx._push({ bytes: 'F1', timestamp: 0 }), TypeError)
})
