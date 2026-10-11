'use strict'
// Minimal WAV reader: PCM 16/24-bit integer and 32-bit float, any channels.

function readWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const tag = (at) => buffer.toString('ascii', at, at + 4)
  if (buffer.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  let format = null
  let at = 12
  while (at + 8 <= buffer.length) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      let code = view.getUint16(body, true)
      if (code === 0xfffe) code = view.getUint16(body + 24, true) // extensible
      format = {
        code,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before fmt chunk')
      const end = Math.min(body + size, buffer.length)
      return { ...format, samples: decode(buffer.subarray(body, end), format) }
    }
    at = body + size + (size & 1)
  }
  throw new Error('WAV file has no data chunk')
}

function decode(data, { code, bits }) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (code === 1 && bits === 16) {
    const out = new Int16Array(data.length >> 1)
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true)
    return out
  }
  if (code === 1 && bits === 24) {
    const out = new Float32Array(Math.floor(data.length / 3))
    for (let i = 0; i < out.length; i++) {
      const v = data[i * 3] | (data[i * 3 + 1] << 8) | (data[i * 3 + 2] << 16)
      out[i] = ((v << 8) >> 8) / 8388608
    }
    return out
  }
  if (code === 3 && bits === 32) {
    const out = new Float32Array(data.length >> 2)
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
    return out
  }
  throw new Error(`unsupported WAV format (code ${code}, ${bits}-bit)`)
}

module.exports = { readWav }
