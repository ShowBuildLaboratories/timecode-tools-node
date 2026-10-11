'use strict'
// The reference LTC test encoder the golden files were made with: a square
// wave (no rise time, no noise) at the nominal frame rate, amplitude 20000,
// eight preamble cells of 1 bits before the frames and eight 0 bits after.

const { Timecode } = require('../..')

const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]

function frameBits(tc) {
  const bits = new Array(80).fill(0)
  const fields = [
    [0, 4, tc.frames % 10],
    [8, 2, Math.floor(tc.frames / 10)],
    [16, 4, tc.seconds % 10],
    [24, 3, Math.floor(tc.seconds / 10)],
    [32, 4, tc.minutes % 10],
    [40, 3, Math.floor(tc.minutes / 10)],
    [48, 4, tc.hours % 10],
    [56, 2, Math.floor(tc.hours / 10)],
  ]
  for (const [start, count, value] of fields) {
    for (let k = 0; k < count; k++) bits[start + k] = (value >> k) & 1
  }
  bits[10] = tc.dropFrame ? 1 : 0
  SYNC.forEach((b, i) => (bits[64 + i] = b))
  return bits
}

/** Int16Array of `frameCount` frames from `start` (a Timecode string). */
function referenceLtc({ sampleRate, frameRate, nominalFps, start, frameCount, amplitude = 20000 }) {
  const cell = sampleRate / (nominalFps * 80)
  const levels = [] // [time in samples, level]
  let target = 0
  let level = 1
  const cellOut = (bit) => {
    level = -level
    levels.push([target, level])
    if (bit === 1) {
      target += cell / 2
      level = -level
      levels.push([target, level])
      target += cell / 2
    } else {
      target += cell
    }
  }
  for (let i = 0; i < 8; i++) cellOut(1)
  let index = Timecode.parse(start, frameRate).frameIndex()
  for (let n = 0; n < frameCount; n++, index++) {
    for (const bit of frameBits(Timecode.fromFrameIndex(index, frameRate))) cellOut(bit)
  }
  for (let i = 0; i < 8; i++) cellOut(0)
  const length = Math.round(target)
  const pcm = new Int16Array(length)
  let edge = 0
  for (let s = 0; s < length; s++) {
    while (edge + 1 < levels.length && Math.round(levels[edge + 1][0]) <= s) edge++
    pcm[s] = Math.round(levels[edge][1] * amplitude)
  }
  return pcm
}

module.exports = { referenceLtc }
