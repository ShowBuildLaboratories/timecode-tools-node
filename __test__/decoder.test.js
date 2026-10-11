'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { LtcDecoder, FrameRate, Timecode, _testing } = require('..')
const { generateLtc } = _testing

function decodeAll(decoder, pcm, block = 1000) {
  const out = []
  for (let i = 0; i < pcm.length; i += block) out.push(...decoder.push(pcm.subarray(i, i + block)))
  return out
}

for (const [frameRate, start] of [
  [FrameRate.Fps24, '10:00:00:00'],
  [FrameRate.Fps25, '01:02:03:04'],
  [FrameRate.Fps2997Drop, '00:00:59;20'],
  [FrameRate.Fps30, '23:59:59:00'],
]) {
  test(`decodes every frame at ${frameRate}`, () => {
    const pcm = generateLtc({ frameRate, start, frameCount: 60 })
    const decoder = new LtcDecoder({ sampleRate: 48000 })
    const frames = decodeAll(decoder, pcm, 777)
    assert.equal(frames.length, 60)
    assert.equal(String(frames[0].timecode), start)
    const first = Timecode.parse(start, frameRate).frameIndex()
    const day = Timecode.fromFrameIndex(-1, frameRate).frameIndex() + 1
    frames.forEach((f, i) => {
      assert.equal(f.frameRate, frameRate)
      assert.equal(f.timecode.frameRate, frameRate)
      assert.equal(f.locked, i >= 3)
      assert.equal(f.timecode.frameIndex(), (first + i) % day)
    })
    assert.equal(decoder.locked, true)
    assert.equal(decoder.frameRate, frameRate)
    assert.ok(decoder.signalLevel > 0.5)
  })
}

test('Float32 input decodes like Int16', () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 20 })
  const float = Float32Array.from(pcm, (s) => s / 32767)
  const a = new LtcDecoder({ sampleRate: 48000 }).push(pcm).map((f) => String(f.timecode))
  const b = new LtcDecoder({ sampleRate: 48000 }).push(float).map((f) => String(f.timecode))
  assert.deepEqual(a, b)
  assert.equal(a.length, 20)
})

test('sample index and timestamps', () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 30 })
  const decoder = new LtcDecoder({ sampleRate: 48000 })
  const frames = []
  for (let i = 0; i < pcm.length; i += 480) {
    // 10 ms blocks with a timestamp 5 s into some monotonic clock.
    frames.push(...decoder.push(pcm.subarray(i, i + 480), 5000 + (i / 48000) * 1000))
  }
  for (let i = 1; i < frames.length; i++) {
    assert.equal(frames[i].sampleIndex - frames[i - 1].sampleIndex, 1920)
  }
  // Frame n of the generated signal starts after an 8-bit preamble.
  const preambleMs = (8 / 80) * 40
  for (const [n, f] of frames.entries()) {
    const ts = f.timecode.timestamp
    assert.ok(Math.abs(ts - (5000 + preambleMs + n * 40)) < 0.2, `${f.timecode} at ${ts}`)
  }
})

test('offsetFrames shifts the label', () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps2997Drop, start: '00:00:59;28', frameCount: 10 })
  const plain = new LtcDecoder({ sampleRate: 48000 }).push(pcm)
  const shifted = new LtcDecoder({ sampleRate: 48000, offsetFrames: 2 }).push(pcm)
  assert.equal(String(plain[0].timecode), '00:00:59;28')
  assert.equal(String(shifted[0].timecode), '00:01:00;02')
  const back = new LtcDecoder({ sampleRate: 48000, offsetFrames: -1 }).push(
    generateLtc({ frameRate: FrameRate.Fps25, frameCount: 2 }),
  )
  assert.equal(String(back[0].timecode), '23:59:59:24')
})

test('fixed frameRate overrides detection', () => {
  const pcm = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 10 })
  const frames = new LtcDecoder({ sampleRate: 48000, frameRate: FrameRate.Fps25 }).push(pcm)
  assert.ok(frames.every((f) => f.frameRate === FrameRate.Fps25))
})

test('multichannel: reads the selected channel', () => {
  const ltc = generateLtc({ frameRate: FrameRate.Fps25, frameCount: 20, start: '05:00:00:00' })
  const channels = 4
  const pcm = new Int16Array(ltc.length * channels)
  for (let i = 0; i < ltc.length; i++) {
    pcm[i * channels] = Math.round(Math.sin(i * 0.03) * 20000) // music-like
    pcm[i * channels + 2] = ltc[i]
  }
  const third = new LtcDecoder({ sampleRate: 48000, channels, channel: 3 })
  assert.equal(decodeAll(third, pcm, 4 * 512).length, 20)
  const first = new LtcDecoder({ sampleRate: 48000, channels })
  assert.equal(decodeAll(first, pcm, 4 * 512).length, 0)
  assert.throws(() => third.push(new Int16Array(3)), /multiple of 4/)
})

test('silence and noise give nothing', () => {
  const decoder = new LtcDecoder({ sampleRate: 44100 })
  assert.deepEqual(decoder.push(new Int16Array(44100)), [])
  let x = 7
  const noise = Int16Array.from({ length: 44100 }, () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return (x >> 8) - 32768
  })
  assert.deepEqual(decoder.push(noise), [])
  assert.equal(decoder.locked, false)
})

test('Timecode parse, format, compare and arithmetic', () => {
  assert.equal(String(Timecode.parse('01:02:03:04')), '01:02:03:04')
  assert.equal(Timecode.parse('00:01:00;02').frameIndex(FrameRate.Fps2997Drop), 1800)
  assert.equal(Timecode.parse('01:00:00:00', FrameRate.Fps2997Drop).frameIndex(), 107892)
  assert.equal(Timecode.parse('01:00:00:00', FrameRate.Fps25).frameIndex(), 90000)
  assert.equal(String(Timecode.fromFrameIndex(17982, FrameRate.Fps2997Drop)), '00:10:00;00')
  assert.equal(String(Timecode.fromFrameIndex(-1, FrameRate.Fps24)), '23:59:59:23')
  assert.equal(Timecode.parse('01:00:00:00').compare(Timecode.parse('00:59:59:29')), 1)
  assert.equal(Timecode.parse('01:00:00:00').compare(Timecode.parse('01:00:00:00')), 0)
  assert.equal(Timecode.parse('01:00:00:00').compare(Timecode.parse('01:00:00:01')), -1)
  assert.equal(JSON.stringify({ tc: Timecode.parse('10:00:00:00') }), '{"tc":"10:00:00:00"}')
  assert.throws(() => Timecode.parse('00:01:00;00', FrameRate.Fps2997Drop), RangeError)
  assert.throws(() => Timecode.parse('00:00:00:25', FrameRate.Fps25), RangeError)
  assert.throws(() => Timecode.parse('00:00:00;10', FrameRate.Fps25), RangeError)
  assert.throws(() => Timecode.parse('1:00:00:00'), SyntaxError)
  assert.throws(() => Timecode.parse('01:00:00:00').frameIndex(), /needs a frame rate/)
  assert.throws(() => Timecode.fromFrameIndex(0, FrameRate.Auto), TypeError)
})

test('option validation', () => {
  assert.throws(() => new LtcDecoder({}), RangeError)
  assert.throws(() => new LtcDecoder({ sampleRate: 48000, frameRate: 29.97 }), TypeError)
  assert.throws(() => new LtcDecoder({ sampleRate: 48000, channels: 2, channel: 3 }), RangeError)
  assert.throws(() => new LtcDecoder({ sampleRate: 48000 }).push([1, 2, 3]), TypeError)
})
