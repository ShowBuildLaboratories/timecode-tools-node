'use strict'

const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const native = require('./native.js')

/** Frame rates, by name. `Auto` detects the rate from the signal. */
const FrameRate = Object.freeze({
  Auto: 'auto',
  Fps24: '24',
  Fps25: '25',
  Fps2997Drop: '29.97df',
  Fps30: '30',
})

// nominal: label rate; hz: real frames per second; drop: drop-frame labels.
const RATES = {
  [FrameRate.Fps24]: { nominal: 24, hz: 24, drop: false },
  [FrameRate.Fps25]: { nominal: 25, hz: 25, drop: false },
  [FrameRate.Fps2997Drop]: { nominal: 30, hz: 30000 / 1001, drop: true },
  [FrameRate.Fps30]: { nominal: 30, hz: 30, drop: false },
}

function checkFrameRate(value, allowAuto) {
  if (value === FrameRate.Auto && allowAuto) return value
  if (RATES[value]) return value
  throw new TypeError(
    `frameRate must be one of ${Object.keys(FrameRate)
      .filter((k) => allowAuto || k !== 'Auto')
      .map((k) => `FrameRate.${k}`)
      .join(', ')}, got ${JSON.stringify(value)}`,
  )
}

function checkInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${value}`)
  }
  return value
}

function checkOffset(offsetFrames) {
  return checkInteger('offsetFrames', offsetFrames, -86400 * 30, 86400 * 30)
}

function checkTimestamp(timestamp) {
  if (timestamp != null && !(Number.isFinite(timestamp) && timestamp >= 0)) {
    throw new TypeError('timestamp must be a non-negative number of milliseconds')
  }
  return timestamp
}

const TIMECODE = /^(\d{2}):(\d{2}):(\d{2})([:;.,])(\d{2})$/

/** A timecode label. */
class Timecode {
  constructor(fields) {
    this.hours = fields.hours
    this.minutes = fields.minutes
    this.seconds = fields.seconds
    this.frames = fields.frames
    this.dropFrame = Boolean(fields.dropFrame)
    /** Rate the label is read at, or null if unknown. */
    this.frameRate = fields.frameRate ?? null
    /** Monotonic ms at which this timecode began (from a receiver), or null. */
    this.timestamp = fields.timestamp ?? null
  }

  /** `HH:MM:SS:FF`, or `HH:MM:SS;FF` for drop-frame. */
  toString() {
    const p = (n) => String(n).padStart(2, '0')
    return `${p(this.hours)}:${p(this.minutes)}:${p(this.seconds)}${this.dropFrame ? ';' : ':'}${p(this.frames)}`
  }

  toJSON() {
    return this.toString()
  }

  /** Frames since 00:00:00:00 at `frameRate` (default: this timecode's rate). */
  frameIndex(frameRate = this.frameRate) {
    if (frameRate == null) throw new Error('frameIndex() needs a frame rate')
    const rate = RATES[checkFrameRate(frameRate, false)]
    return native.frameIndex(this, rate.nominal)
  }

  /** -1, 0 or 1: orders by the digits (ignores the rate and timestamp). */
  compare(other) {
    const key = (t) => ((t.hours * 60 + t.minutes) * 60 + t.seconds) * 100 + t.frames
    return Math.sign(key(this) - key(other))
  }

  /**
   * Parses `HH:MM:SS:FF` (`;` before the frames means drop-frame). With a
   * frame rate, the drop-frame flag follows the rate and the frame number
   * must exist at that rate.
   */
  static parse(text, frameRate = null) {
    const m = TIMECODE.exec(String(text))
    if (!m) throw new SyntaxError(`expected HH:MM:SS:FF, got ${JSON.stringify(text)}`)
    const [hours, minutes, seconds, frames] = [m[1], m[2], m[3], m[5]].map(Number)
    let dropFrame = m[4] !== ':'
    if (frameRate === FrameRate.Auto) frameRate = null
    if (frameRate != null) {
      checkFrameRate(frameRate, false)
      if (dropFrame && !RATES[frameRate].drop) {
        throw new RangeError(`${text} is drop-frame but the frame rate is ${frameRate}`)
      }
      dropFrame = RATES[frameRate].drop
    }
    const nominal = frameRate ? RATES[frameRate].nominal : 30
    const skipped = dropFrame && frameRate && seconds === 0 && minutes % 10 !== 0 && frames < 2
    if (hours > 23 || minutes > 59 || seconds > 59 || frames >= nominal || skipped) {
      throw new RangeError(`${text} is not a valid timecode${frameRate ? ` at ${frameRate}` : ''}`)
    }
    return new Timecode({ hours, minutes, seconds, frames, dropFrame, frameRate })
  }

  /** Timecode for a frame count since 00:00:00:00 (wraps around one day). */
  static fromFrameIndex(index, frameRate) {
    const rate = RATES[checkFrameRate(frameRate, false)]
    checkInteger('index', index, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    return new Timecode({ ...native.labelFromIndex(index, rate.nominal, rate.drop), frameRate })
  }
}

function fromNative(t) {
  return new Timecode({
    hours: t.hours,
    minutes: t.minutes,
    seconds: t.seconds,
    frames: t.frames,
    dropFrame: t.dropFrame,
    frameRate: t.frameRate ?? null,
    timestamp: t.timestamp ?? null,
  })
}

function toSamples(samples) {
  if (samples instanceof Int16Array || samples instanceof Float32Array) return samples
  throw new TypeError('samples must be an Int16Array or a Float32Array')
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return Uint8Array.from(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new TypeError('MIDI data must be a Uint8Array, Buffer or array of bytes')
}

/**
 * Low-level LTC decoder: push interleaved PCM, get back the frames completed
 * in that block, locked or not. No events, timers or stream handling.
 */
class LtcDecoder {
  constructor(options = {}) {
    const { sampleRate, channels = 1, channel = 1, frameRate = FrameRate.Auto, offsetFrames = 0 } = options
    checkInteger('sampleRate', sampleRate, 8000, 768000)
    checkInteger('channels', channels, 1, 64)
    checkInteger('channel', channel, 1, channels)
    checkFrameRate(frameRate, true)
    checkOffset(offsetFrames)
    this._args = [sampleRate, channels, channel, frameRate, offsetFrames]
    this._native = new native.NativeLtcDecoder(...this._args)
    this.sampleRate = sampleRate
    this.channels = channels
  }

  /**
   * Decodes a block of interleaved samples. Returns
   * `{ timecode, locked, frameRate, sampleIndex }` for each frame completed.
   * @param samples Int16Array, or Float32Array in -1..1
   * @param timestamp monotonic time in ms of the first sample (optional)
   */
  push(samples, timestamp) {
    toSamples(samples)
    const ts = checkTimestamp(timestamp) ?? undefined
    const frames =
      samples instanceof Int16Array ? this._native.pushInt16(samples, ts) : this._native.pushFloat32(samples, ts)
    return frames.map((f) => ({
      timecode: fromNative(f),
      locked: f.locked,
      frameRate: f.frameRate ?? null,
      sampleIndex: f.sampleIndex,
    }))
  }

  /** Clears all decoding state; sample counting restarts at zero. */
  reset() {
    this._native = new native.NativeLtcDecoder(...this._args)
  }

  get locked() {
    return this._native.locked
  }
  /** Configured rate, or the detected one with FrameRate.Auto (null if unknown). */
  get frameRate() {
    return this._native.frameRate ?? null
  }
  /** Peak input level, 0..1. */
  get signalLevel() {
    return this._native.signalLevel
  }
  /** Samples per channel decoded so far. */
  get samplesDecoded() {
    return this._native.samplesDecoded
  }
}

// Event delivered to addEventListener listeners; `detail` carries the same
// value the EventEmitter listener receives.
class TimecodeEvent extends Event {
  constructor(type, detail) {
    super(type)
    this.detail = detail
  }
}

// Async iterator over emitter events. With buffer 'latest' (default) only the
// newest unread item is kept; with 'all' every item is queued.
// An 'error' event (when `errors` is set) ends the iteration with that error
// once the items before it have been read.
function subscribe(emitter, types, map, options = {}, errors = false) {
  const { buffer = 'latest', signal } = options
  if (buffer !== 'latest' && buffer !== 'all') {
    throw new TypeError(`buffer must be 'latest' or 'all', got ${JSON.stringify(buffer)}`)
  }
  const queue = []
  let wake = null
  let done = false
  let failure = null
  const handlers = types.map((type) => {
    const handler = (...args) => {
      if (done) return
      if (buffer === 'latest') queue.length = 0
      queue.push(map(type, ...args))
      if (wake) {
        const w = wake
        wake = null
        w()
      }
    }
    emitter.on(type, handler)
    return [type, handler]
  })
  if (errors) {
    const onError = (error) => {
      if (done) return
      failure = { error }
      finish()
    }
    emitter.on('error', onError)
    handlers.push(['error', onError])
  }
  const finish = () => {
    if (done) return
    done = true
    for (const [type, handler] of handlers) emitter.off(type, handler)
    if (signal) signal.removeEventListener('abort', finish)
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }
  if (signal) {
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  }
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      while (queue.length === 0 && !done) await new Promise((resolve) => (wake = resolve))
      if (queue.length > 0) return { value: queue.shift(), done: false }
      if (failure) {
        const { error } = failure
        failure = null
        throw error
      }
      return { value: undefined, done: true }
    },
    async return() {
      finish()
      queue.length = 0
      return { value: undefined, done: true }
    },
  }
}

const STATE_EVENTS = ['lock', 'lost', 'jump', 'end']

/**
 * The interface shared by LtcReceiver and MtcReceiver: lock / lost / jump
 * events, waitFor, stream attachment and three ways of listening. The
 * timecode logic itself runs in the Rust core.
 */
class TimecodeReceiver extends EventEmitter {
  constructor(native, options) {
    super()
    if (new.target === TimecodeReceiver) throw new TypeError('use LtcReceiver or MtcReceiver')
    this._native = native
    this._frameRate = options.frameRate
    this._lostAfter = options.lostAfter
    this._current = null
    this._waiters = new Set()
    this._iterators = new Set()
    this._source = null
    this._watchdog = null
    this._lastChunkAt = null
    this._chunkGap = 0
    this._closed = false
    this._domListeners = new Map()
  }

  /**
   * EventTarget-style listening. The listener gets an Event whose `detail`
   * is what the EventEmitter listener would receive.
   */
  addEventListener(type, listener, options = {}) {
    if (listener == null) return
    const call = typeof listener === 'function' ? listener : (e) => listener.handleEvent(e)
    const key = `${type}`
    let byType = this._domListeners.get(key)
    if (!byType) this._domListeners.set(key, (byType = new Map()))
    if (byType.has(listener)) return
    const once = typeof options === 'object' && options.once
    const signal = typeof options === 'object' ? options.signal : undefined
    if (signal && signal.aborted) return
    const wrapper = (detail) => {
      if (once) this.removeEventListener(type, listener)
      call.call(this, new TimecodeEvent(type, detail))
    }
    byType.set(listener, wrapper)
    this.on(type, wrapper)
    if (signal) signal.addEventListener('abort', () => this.removeEventListener(type, listener), { once: true })
  }

  removeEventListener(type, listener) {
    const byType = this._domListeners.get(`${type}`)
    const wrapper = byType && byType.get(listener)
    if (!wrapper) return
    byType.delete(listener)
    this.off(type, wrapper)
  }

  /**
   * Async iterator of frames (as the 'frame' event). Leaving the loop
   * unsubscribes. By default a slow consumer gets only the newest frame;
   * pass `{ buffer: 'all' }` to receive every frame.
   */
  frames(options) {
    return this._track(subscribe(this, ['frame'], (_, tc) => tc, options))
  }

  /**
   * Async iterator of state changes: `{ type: 'lock', timecode, frameRate,
   * channel }`, `{ type: 'lost' }`, `{ type: 'jump', timecode }` and
   * `{ type: 'end' }` (the attached input finished). An 'error' from the
   * input makes the iterator throw.
   */
  events(options) {
    return this._track(
      subscribe(
        this,
        STATE_EVENTS,
        (type, detail) =>
          type === 'lock' ? { type, ...detail } : type === 'jump' ? { type, timecode: detail } : { type },
        options,
        true,
      ),
    )
  }

  _track(iterator) {
    if (this._closed) {
      iterator.return()
      return iterator
    }
    this._iterators.add(iterator)
    const original = iterator.return
    iterator.return = async () => {
      this._iterators.delete(iterator)
      return original.call(iterator)
    }
    return iterator
  }

  /** True between 'lock' and 'lost'. */
  get locked() {
    return this._native.locked
  }
  /** The most recent frame, or the position of an MTC locate. */
  get current() {
    return this._current
  }
  /** The configured frame rate (`FrameRate.Auto`: from the source). */
  get frameRate() {
    return this._frameRate
  }
  /** The rate in use: configured, or detected; null until known. */
  get detectedRate() {
    return this._native.detectedRate ?? null
  }
  /** Frames added to every timecode (latency compensation). Can be changed. */
  get offsetFrames() {
    return this._native.offsetFrames
  }
  set offsetFrames(frames) {
    this._native.offsetFrames = checkOffset(frames)
  }
  /** ms without a followed frame before 'lost'. */
  get lostAfter() {
    return this._lostAfter
  }
  /** True while a stream is attached. */
  get attached() {
    return this._source != null
  }
  /** True after close(). */
  get closed() {
    return this._closed
  }

  /** Starts reading chunks from a Readable (object mode) or an async iterable. */
  attach(stream) {
    if (this._closed) throw new Error('receiver is closed')
    if (this._source) throw new Error('already attached; call detach() first')
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('attach() expects a Readable or an async iterable')
    }
    const iterator = stream[Symbol.asyncIterator]()
    const source = { stream, iterator, active: true }
    this._source = source
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await iterator.next()
          if (done || !source.active) break
          this._push(value)
        }
      } catch (error) {
        if (source.active) this.emit('error', error)
      } finally {
        if (this._source === source) {
          this._source = null
          this._lose()
          this.emit('end')
        }
      }
    })()
    return this
  }

  /** Stops reading from the attached stream and reports 'lost' if locked. */
  detach() {
    const source = this._source
    if (source) {
      source.active = false
      this._source = null
      if (typeof source.iterator.return === 'function') {
        Promise.resolve(source.iterator.return()).catch(() => {})
      }
    }
    this._lose()
  }

  /**
   * Detaches, ends every frames()/events() iterator and rejects pending
   * waitFor() calls. The receiver cannot be used afterwards.
   */
  close() {
    if (this._closed) return
    this.detach()
    this._closed = true
    if (this._watchdog) clearTimeout(this._watchdog)
    for (const it of [...this._iterators]) it.return()
    for (const waiter of [...this._waiters]) {
      this._waiters.delete(waiter)
      waiter.cleanup()
      waiter.reject(new Error('receiver closed'))
    }
  }

  /**
   * Resolves with the first timecode at or past `target` that directly
   * continues a frame before it (normal playback). A jump over or onto the
   * target does not count. Rejects if the receiver is closed first.
   */
  waitFor(target, options = {}) {
    const text = String(target)
    Timecode.parse(text) // validate the format now
    if (this._closed) return Promise.reject(new Error('receiver closed'))
    const { signal } = options
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(signal.reason ?? new Error('aborted'))
      const waiter = { text, resolve, reject }
      const onAbort = () => {
        this._waiters.delete(waiter)
        reject(signal.reason ?? new Error('aborted'))
      }
      waiter.cleanup = () => signal && signal.removeEventListener('abort', onAbort)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this._waiters.add(waiter)
    })
  }

  _checkOpen() {
    if (this._closed) throw new Error('receiver is closed')
  }

  _dispatch(events) {
    for (const e of events) {
      if (e.kind === 'lost') {
        this.emit('lost')
        continue
      }
      const tc = fromNative(e.timecode)
      if (e.kind === 'lock') {
        this.emit('lock', { timecode: tc, frameRate: tc.frameRate, channel: e.timecode.channel ?? null })
      } else if (e.kind === 'jump') {
        this._current = tc
        this.emit('jump', tc)
      } else {
        this._current = tc
        this.emit('frame', tc)
        if (e.previous != null) this._resolveWaiters(tc, e.previous)
      }
    }
  }

  _resolveWaiters(tc, previous) {
    const rate = RATES[tc.frameRate]
    const day = native.framesPerDay(rate.nominal, rate.drop)
    const index = tc.frameIndex()
    const mod = (n) => ((n % day) + day) % day
    const step = mod(index - previous)
    if (step <= 0) return
    for (const waiter of [...this._waiters]) {
      let target
      try {
        target = Timecode.parse(waiter.text, tc.frameRate).frameIndex()
      } catch {
        continue // not valid at this rate
      }
      if (mod(index - target) < step) {
        this._waiters.delete(waiter)
        waiter.cleanup()
        waiter.resolve(tc)
      }
    }
  }

  _lose() {
    if (this._watchdog) clearTimeout(this._watchdog)
    this._watchdog = null
    this._dispatch(this._native.signalLost())
  }

  // Detects loss when chunks stop arriving altogether: no chunk for
  // lostAfter plus twice the usual gap between chunks (so input delivered in
  // large blocks is not mistaken for a stop).
  _afterChunk() {
    const now = performance.now()
    if (this._lastChunkAt != null) this._chunkGap = Math.min(now - this._lastChunkAt, 5000)
    this._lastChunkAt = now
    if (this._watchdog) clearTimeout(this._watchdog)
    this._watchdog = null
    if (!this._native.locked || this._closed) return
    this._watchdog = setTimeout(() => {
      this._watchdog = null
      this._lose()
    }, this._lostAfter + 2 * this._chunkGap)
    if (typeof this._watchdog.unref === 'function') this._watchdog.unref()
  }
}

function receiverOptions(options = {}) {
  const { frameRate = FrameRate.Auto, offsetFrames = 0, lostAfter = 300 } = options
  checkFrameRate(frameRate, true)
  checkOffset(offsetFrames)
  if (!(Number.isFinite(lostAfter) && lostAfter > 0)) throw new RangeError('lostAfter must be a positive number of ms')
  return { frameRate, offsetFrames, lostAfter }
}

/**
 * Follows LTC in a stream of PCM chunks
 * `{ samples, sampleRate, channels?, timestamp? }`.
 */
class LtcReceiver extends TimecodeReceiver {
  constructor(options = {}) {
    const o = receiverOptions(options)
    const { channel = 1 } = options
    checkInteger('channel', channel, 1, 64)
    super(new native.NativeLtcReceiver(o.frameRate, o.offsetFrames, o.lostAfter, channel), o)
    this._channel = channel
  }

  /** One-based channel that carries LTC. */
  get channel() {
    return this._channel
  }
  /** Recent peak input level of the LTC channel, 0..1. */
  get level() {
    return this._native.level
  }

  _push(chunk) {
    this._checkOpen()
    if (!chunk || typeof chunk !== 'object') throw new TypeError('chunk must be an object')
    const samples = toSamples(chunk.samples)
    const sampleRate = checkInteger('sampleRate', chunk.sampleRate, 8000, 768000)
    const channels = checkInteger('channels', chunk.channels ?? 1, 1, 64)
    const at = checkTimestamp(chunk.timestamp) ?? performance.now()
    this._dispatch(
      samples instanceof Int16Array
        ? this._native.pushInt16(samples, sampleRate, channels, at)
        : this._native.pushFloat32(samples, sampleRate, channels, at),
    )
    this._afterChunk()
  }
}

/**
 * Follows MIDI Time Code in a stream of MIDI bytes: `Uint8Array`, `Buffer`,
 * byte arrays, or `{ bytes, timestamp? }`. A full-frame message (a locate)
 * ends any chase and is reported as a jump.
 */
class MtcReceiver extends TimecodeReceiver {
  constructor(options = {}) {
    const o = receiverOptions(options)
    super(new native.NativeMtcReceiver(o.frameRate, o.offsetFrames, o.lostAfter), o)
  }

  _push(chunk) {
    this._checkOpen()
    const wrapped = chunk && typeof chunk === 'object' && !ArrayBuffer.isView(chunk) && !Array.isArray(chunk)
    const bytes = toBytes(wrapped ? chunk.bytes : chunk)
    const at = checkTimestamp(wrapped ? chunk.timestamp : undefined) ?? performance.now()
    this._dispatch(this._native.push(bytes, at))
    this._afterChunk()
  }
}

// Test-signal helpers. Not part of the public API.
function generateLtc(options = {}) {
  const { sampleRate = 48000, frameRate = FrameRate.Fps25, start = '00:00:00:00', frameCount = 25, amplitude = 0.6 } =
    options
  checkFrameRate(frameRate, false)
  const startIndex = Timecode.parse(String(start), frameRate).frameIndex()
  return native.generateLtc(sampleRate, frameRate, startIndex, frameCount, amplitude)
}

function generateMtc(options = {}) {
  const { frameRate = FrameRate.Fps25, start = '00:00:00:00', frameCount = 50 } = options
  checkFrameRate(frameRate, false)
  return native.generateMtc(frameRate, Timecode.parse(String(start), frameRate).frameIndex(), frameCount)
}

function mtcFullFrame(timecode, frameRate) {
  return native.mtcFullFrame(frameRate, Timecode.parse(String(timecode), frameRate))
}

module.exports = { FrameRate, Timecode, TimecodeReceiver, LtcReceiver, MtcReceiver, LtcDecoder }
Object.defineProperty(module.exports, '_testing', {
  value: Object.freeze({ generateLtc, generateMtc, mtcFullFrame }),
  enumerable: false,
})
