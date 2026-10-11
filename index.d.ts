/// <reference types="node" />
import { EventEmitter } from 'node:events'

/** Frame rates, chosen by name. `Auto` detects the rate from the source. */
export declare const FrameRate: {
  readonly Auto: 'auto'
  readonly Fps24: '24'
  readonly Fps25: '25'
  /** 29.97 fps drop-frame. */
  readonly Fps2997Drop: '29.97df'
  /** 30 fps (29.97 non-drop reads the same). */
  readonly Fps30: '30'
}
export type FrameRate = (typeof FrameRate)[keyof typeof FrameRate]
/** A concrete frame rate (anything but `Auto`). */
export type FixedFrameRate = Exclude<FrameRate, 'auto'>

/** Interleaved PCM: 16-bit integers, or floats in -1..1. */
export type PcmSamples = Int16Array | Float32Array

/** One block of audio for {@link LtcReceiver.attach}. */
export interface PcmChunk {
  /** Interleaved samples. */
  samples: PcmSamples
  /** Sample rate in Hz. */
  sampleRate: number
  /** Number of interleaved channels. Default 1. */
  channels?: number
  /**
   * Monotonic time in ms (e.g. `performance.now()`) at which the first
   * sample was captured. If omitted, the time the chunk is received is used
   * instead, which is less precise.
   */
  timestamp?: number
}

/**
 * Raw MIDI bytes for {@link MtcReceiver.attach}: any MIDI traffic, from
 * which quarter-frame and full-frame MTC messages are picked out.
 */
export type MidiChunk =
  | Uint8Array
  | number[]
  | {
      bytes: Uint8Array | number[]
      /** Monotonic ms the bytes arrived. Default: when the chunk is received. */
      timestamp?: number
    }

/** A timecode label. */
export declare class Timecode {
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
  readonly frames: number
  readonly dropFrame: boolean
  /** Rate the label is read at; null if unknown. */
  readonly frameRate: FixedFrameRate | null
  /**
   * From a receiver: monotonic ms at which this timecode began, in the clock
   * of the chunk timestamps. Otherwise null.
   */
  readonly timestamp: number | null

  /** `HH:MM:SS:FF`, or `HH:MM:SS;FF` for drop-frame. */
  toString(): string
  toJSON(): string
  /** Frames since 00:00:00:00 at `frameRate` (default: this timecode's rate). */
  frameIndex(frameRate?: FixedFrameRate): number
  /** -1, 0 or 1, ordering by the digits. */
  compare(other: Timecode): -1 | 0 | 1

  /**
   * Parses `HH:MM:SS:FF` (`;` before the frames means drop-frame). With a
   * frame rate, the drop-frame flag follows the rate and the frame number
   * must exist at that rate.
   */
  static parse(text: string, frameRate?: FrameRate | null): Timecode
  /** Timecode for a frame count since 00:00:00:00, wrapping around one day. */
  static fromFrameIndex(index: number, frameRate: FixedFrameRate): Timecode
}

export interface ReceiverOptions {
  /** Default `FrameRate.Auto` (from the source). */
  frameRate?: FrameRate
  /**
   * Latency compensation in frames, added to every timecode. Positive when
   * the signal reaches you late. Default 0.
   */
  offsetFrames?: number
  /** ms without a followed frame before `lost`. Default 300. */
  lostAfter?: number
}

export interface LtcReceiverOptions extends ReceiverOptions {
  /** One-based channel that carries LTC. Default 1. */
  channel?: number
}

export interface LockInfo {
  timecode: Timecode
  frameRate: FixedFrameRate
  /** LTC: the channel read. Null for MTC. */
  channel: number | null
}

export interface ReceiverEvents {
  /** A frame on the followed timeline (only while locked). */
  frame: [timecode: Timecode]
  /** The source became stable. The first `frame` follows. */
  lock: [info: LockInfo]
  /** Nothing followed for `lostAfter`, the input stopped or was detached, or (MTC) a locate. */
  lost: []
  /** The timecode moved discontinuously, or (MTC) a full-frame locate. */
  jump: [timecode: Timecode]
  /** The attached stream ended. */
  end: []
  /** The attached stream failed. */
  error: [error: unknown]
}

/** Event passed to `addEventListener` listeners. */
export interface TimecodeEvent<T> extends Event {
  readonly detail: T
}

/** Detail type of each event, for `addEventListener`. */
export interface ReceiverEventDetails {
  frame: Timecode
  lock: LockInfo
  lost: undefined
  jump: Timecode
  end: undefined
  error: unknown
}

/** Items yielded by {@link TimecodeReceiver.events}. */
export type StateEvent =
  | ({ type: 'lock' } & LockInfo)
  | { type: 'lost' }
  | { type: 'jump'; timecode: Timecode }
  | { type: 'end' }

export interface IterateOptions {
  /**
   * `'latest'` (default): a slow consumer gets only the newest item and
   * older unread ones are dropped. `'all'`: every item is queued.
   */
  buffer?: 'latest' | 'all'
  /** Ends the iteration when aborted. */
  signal?: AbortSignal
}

type Listener<K extends keyof ReceiverEventDetails> =
  | ((event: TimecodeEvent<ReceiverEventDetails[K]>) => void)
  | { handleEvent(event: TimecodeEvent<ReceiverEventDetails[K]>): void }

/**
 * The interface shared by {@link LtcReceiver} and {@link MtcReceiver}. Code
 * written against it works with either:
 *
 * ```ts
 * function follow(rx: TimecodeReceiver) {
 *   rx.on('frame', (tc) => update(tc))
 * }
 * ```
 */
export interface TimecodeReceiver<Chunk = unknown> extends EventEmitter<ReceiverEvents> {
  /** Reads chunks from a Readable (object mode) or an async iterable. */
  attach(stream: AsyncIterable<Chunk>): this
  /** Stops reading from the attached stream; reports `lost` if locked. */
  detach(): void
  /**
   * Detaches, ends every `frames()`/`events()` iterator and rejects pending
   * `waitFor()` calls. The receiver cannot be used afterwards.
   */
  close(): void
  /** Frames as an async iterator. Leaving the loop unsubscribes. */
  frames(options?: IterateOptions): AsyncIterableIterator<Timecode>
  /**
   * lock / lost / jump / end as an async iterator; throws if the input
   * fails. Leaving the loop unsubscribes.
   */
  events(options?: IterateOptions): AsyncIterableIterator<StateEvent>
  addEventListener<K extends keyof ReceiverEventDetails>(
    type: K,
    listener: Listener<K> | null,
    options?: { once?: boolean; signal?: AbortSignal },
  ): void
  removeEventListener<K extends keyof ReceiverEventDetails>(type: K, listener: Listener<K> | null): void
  /**
   * Resolves with the first timecode at or past `target` that directly
   * continues a frame before it (normal playback). A jump over or onto the
   * target does not count. Rejects if the receiver is closed first.
   */
  waitFor(target: string | Timecode, options?: { signal?: AbortSignal }): Promise<Timecode>
  /**
   * The timecode at `timestamp` (ms, the same monotonic clock as the chunk
   * timestamps), interpolated or extrapolated from the recent signal, with
   * `offsetFrames` applied. null until the signal has been locked long
   * enough to fit a clock, after it is lost, or after `close()`.
   */
  positionAt(timestamp: number): Timecode | null
  /**
   * `positionAt()` as a fractional frame count since 00:00:00:00 (not
   * wrapped at midnight).
   */
  framesAt(timestamp: number): number | null
  /** The configured frame rate. */
  readonly frameRate: FrameRate
  /** The rate in use (configured or detected); null until known. */
  readonly detectedRate: FixedFrameRate | null
  /** Latency compensation in frames. Can be changed while running. */
  offsetFrames: number
  /** ms without a followed frame before `lost`. */
  readonly lostAfter: number
  /** True between `lock` and `lost`. */
  readonly locked: boolean
  /** The most recent frame, or the position of an MTC locate. */
  readonly current: Timecode | null
  /** True while a stream is attached. */
  readonly attached: boolean
  /** True after `close()`. */
  readonly closed: boolean
}

/** Base class of the receivers, for `instanceof` checks. */
export declare const TimecodeReceiver: abstract new (...args: never[]) => TimecodeReceiver

/** Follows LTC in a stream of PCM chunks. */
export declare class LtcReceiver extends EventEmitter<ReceiverEvents> implements TimecodeReceiver<PcmChunk> {
  constructor(options?: LtcReceiverOptions)
  /** One-based channel that carries LTC. */
  readonly channel: number
  /** Recent peak input level of the LTC channel, 0..1. */
  readonly level: number

  attach(stream: AsyncIterable<PcmChunk>): this
  detach(): void
  close(): void
  frames(options?: IterateOptions): AsyncIterableIterator<Timecode>
  events(options?: IterateOptions): AsyncIterableIterator<StateEvent>
  addEventListener<K extends keyof ReceiverEventDetails>(
    type: K,
    listener: Listener<K> | null,
    options?: { once?: boolean; signal?: AbortSignal },
  ): void
  removeEventListener<K extends keyof ReceiverEventDetails>(type: K, listener: Listener<K> | null): void
  waitFor(target: string | Timecode, options?: { signal?: AbortSignal }): Promise<Timecode>
  positionAt(timestamp: number): Timecode | null
  framesAt(timestamp: number): number | null
  readonly frameRate: FrameRate
  readonly detectedRate: FixedFrameRate | null
  offsetFrames: number
  readonly lostAfter: number
  readonly locked: boolean
  readonly current: Timecode | null
  readonly attached: boolean
  readonly closed: boolean
}

/**
 * Follows MIDI Time Code in a stream of MIDI bytes: a frame per frame from
 * quarter frames. A full-frame message (a locate) ends any chase and is
 * reported as a `jump`.
 */
export declare class MtcReceiver extends EventEmitter<ReceiverEvents> implements TimecodeReceiver<MidiChunk> {
  constructor(options?: ReceiverOptions)

  attach(stream: AsyncIterable<MidiChunk>): this
  detach(): void
  close(): void
  frames(options?: IterateOptions): AsyncIterableIterator<Timecode>
  events(options?: IterateOptions): AsyncIterableIterator<StateEvent>
  addEventListener<K extends keyof ReceiverEventDetails>(
    type: K,
    listener: Listener<K> | null,
    options?: { once?: boolean; signal?: AbortSignal },
  ): void
  removeEventListener<K extends keyof ReceiverEventDetails>(type: K, listener: Listener<K> | null): void
  waitFor(target: string | Timecode, options?: { signal?: AbortSignal }): Promise<Timecode>
  positionAt(timestamp: number): Timecode | null
  framesAt(timestamp: number): number | null
  readonly frameRate: FrameRate
  readonly detectedRate: FixedFrameRate | null
  offsetFrames: number
  readonly lostAfter: number
  readonly locked: boolean
  readonly current: Timecode | null
  readonly attached: boolean
  readonly closed: boolean
}

export interface LtcDecoderOptions {
  /** Sample rate in Hz (8000..768000). */
  sampleRate: number
  /** Interleaved channels. Default 1. */
  channels?: number
  /** One-based channel that carries LTC. Default 1. */
  channel?: number
  /** Default `FrameRate.Auto`. */
  frameRate?: FrameRate
  /** Added to every decoded label. Default 0. */
  offsetFrames?: number
}

/** One frame from {@link LtcDecoder.push}. */
export interface DecodedFrame {
  /** The label (with `frameRate` and, if a timestamp was given, `timestamp`). */
  timecode: Timecode
  /** Whether the decoder was locked after this frame. */
  locked: boolean
  /** Rate the label is read at; null while unknown. */
  frameRate: FixedFrameRate | null
  /** One-based sample (per channel) at which the frame's last edge was detected. */
  sampleIndex: number
}

/**
 * Low-level decoder: push interleaved PCM, get back the frames completed in
 * that block (locked or not). No events, timers or stream handling.
 */
export declare class LtcDecoder {
  constructor(options: LtcDecoderOptions)
  readonly sampleRate: number
  readonly channels: number
  /** @param timestamp monotonic ms of the first sample, for `timecode.timestamp`. */
  push(samples: PcmSamples, timestamp?: number): DecodedFrame[]
  /** Clears all decoding state; sample counting restarts at zero. */
  reset(): void
  readonly locked: boolean
  /** Configured rate, or the detected one with `Auto` (null if unknown). */
  readonly frameRate: FixedFrameRate | null
  /** Peak input level, 0..1. */
  readonly signalLevel: number
  /** Samples per channel decoded so far. */
  readonly samplesDecoded: number
}
