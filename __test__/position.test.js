'use strict'
// positionAt() / framesAt(): the timecode at any instant, from a fit of the
// recent signal.
const test = require('node:test')
const assert = require('node:assert/strict')
const { LtcReceiver, MtcReceiver, FrameRate, Timecode, _testing } = require('..')
const { generateLtc, generateMtc } = _testing

const RATE = 48000

function feedLtc(rx, pcm, { block = 480, t0 = 1000 } = {}) {
  for (let i = 0; i < pcm.length; i += block) {
    rx._push({ samples: pcm.subarray(i, i + block), sampleRate: RATE, timestamp: t0 + (i / RATE) * 1000 })
  }
}

function framesOf(rx) {
  const frames = []
  rx.on('frame', (tc) => frames.push(tc))
  return frames
}

test('LTC: positionAt matches the frame timestamps', () => {
  const rx = new LtcReceiver()
  const frames = framesOf(rx)
  assert.equal(rx.framesAt(1000), null, 'null before any input')
  assert.equal(rx.positionAt(1000), null)
  feedLtc(rx, generateLtc({ frameRate: FrameRate.Fps25, start: '01:00:00:00', frameCount: 50 }))
  const last = frames.at(-1)
  const f = rx.framesAt(last.timestamp)
  assert.ok(Math.abs(f - last.frameIndex()) <= 0.25, `${f} vs ${last.frameIndex()}`)
  // 1 us into the frame: the core reads timestamps in whole microseconds,
  // so exactly at a frame's own (sub-microsecond) timestamp the fit can
  // still be a hair before that frame.
  const at = rx.positionAt(last.timestamp + 0.001)
  assert.ok(at instanceof Timecode)
  assert.equal(String(at), String(last))
  assert.equal(at.frameRate, FrameRate.Fps25)
  assert.equal(at.timestamp, last.timestamp + 0.001)
  // Half a frame later: still the same frame. 10 frames later: extrapolated.
  assert.equal(String(rx.positionAt(last.timestamp + 20)), String(last))
  assert.ok(Math.abs(rx.framesAt(last.timestamp + 400) - (last.frameIndex() + 10)) <= 0.25)
  rx.close()
})

test('LTC: framesAt is not wrapped at midnight; positionAt is', () => {
  const rx = new LtcReceiver()
  const frames = framesOf(rx)
  feedLtc(rx, generateLtc({ frameRate: FrameRate.Fps30, start: '23:59:59:00', frameCount: 60 }))
  const last = frames.at(-1)
  assert.match(String(last), /^00:00:00:/)
  const day = Timecode.fromFrameIndex(-1, FrameRate.Fps30).frameIndex() + 1
  const f = rx.framesAt(last.timestamp)
  assert.ok(Math.abs(f - (day + last.frameIndex())) <= 0.25, `${f}`)
  assert.equal(String(rx.positionAt(last.timestamp + 0.001)), String(last))
  rx.close()
})

test('LTC: offsetFrames is applied', () => {
  const rx = new LtcReceiver()
  const frames = framesOf(rx)
  feedLtc(rx, generateLtc({ frameRate: FrameRate.Fps25, start: '01:00:00:00', frameCount: 50 }))
  const t = frames.at(-1).timestamp
  const before = rx.framesAt(t)
  rx.offsetFrames = 2
  assert.ok(Math.abs(rx.framesAt(t) - (before + 2)) < 1e-9)
  rx.close()
})

test('LTC: null after loss and after close()', () => {
  const rx = new LtcReceiver()
  const frames = framesOf(rx)
  const ltc = generateLtc({ frameRate: FrameRate.Fps25, start: '01:00:00:00', frameCount: 50 })
  const pcm = new Int16Array(ltc.length + RATE)
  pcm.set(ltc)
  feedLtc(rx, pcm)
  assert.equal(rx.locked, false)
  assert.equal(rx.framesAt(frames.at(-1).timestamp), null)
  assert.equal(rx.positionAt(frames.at(-1).timestamp), null)

  const rx2 = new LtcReceiver()
  const frames2 = framesOf(rx2)
  feedLtc(rx2, ltc)
  const t = frames2.at(-1).timestamp
  assert.notEqual(rx2.framesAt(t), null)
  rx2.close()
  assert.equal(rx2.framesAt(t), null)
  assert.equal(rx2.positionAt(t), null)
})

test('MTC: positionAt after lock', () => {
  const rx = new MtcReceiver()
  const frames = framesOf(rx)
  const stream = generateMtc({ frameRate: FrameRate.Fps30, start: '00:00:00:00', frameCount: 30 })
  for (let i = 0; i < stream.times.length; i++) {
    rx._push({ bytes: stream.bytes.subarray(i * 2, i * 2 + 2), timestamp: 1000 + stream.times[i] })
  }
  assert.equal(rx.locked, true)
  const last = frames.at(-1)
  assert.equal(String(rx.positionAt(last.timestamp + 0.001)), String(last))
  assert.ok(Math.abs(rx.framesAt(last.timestamp) - last.frameIndex()) <= 0.25)
  rx.close()
})

test('framesAt / positionAt check the timestamp', () => {
  const rx = new MtcReceiver()
  for (const bad of [undefined, null, -1, NaN, Infinity, '10']) {
    assert.throws(() => rx.framesAt(bad), TypeError)
    assert.throws(() => rx.positionAt(bad), TypeError)
  }
  rx.close()
})
