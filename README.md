# timecode-tools

Timecode readers for Node.js: **SMPTE LTC** from PCM audio and **MIDI Time
Code** from MIDI bytes. Stream input in; get timecode, lock, loss and jump
events. The core is Rust
([`timecode-tools` crate](https://crates.io/crates/timecode-tools)) and ships
as prebuilt binaries, so no compiler is needed.

- `LtcReceiver` and `MtcReceiver` share one interface, `TimecodeReceiver`:
  the same `Timecode`, `FrameRate`, events, `waitFor()` and three ways of
  listening
- 24, 25, 29.97 drop-frame and 30 fps, detected automatically
- Any sample rate, Int16 or Float32 samples, mono or multichannel
- MTC quarter-frame and full-frame (SysEx) messages, picked out of any MIDI
  traffic, with a reading every frame
- Smooths delivery jitter using chunk timestamps, so each frame carries an
  accurate start time
- Rejects single corrupt frames; reports real jumps (relocates) after two
  contiguous frames
- Same results as the Dart package [`timecode_tools`](https://pub.dev/packages/timecode_tools)
- TypeScript definitions included

```sh
npm install timecode-tools
```

Node.js 18 or later. Prebuilt for macOS (arm64, x64), Windows (x64, arm64)
and Linux (x64, arm64, armv7; glibc and musl).

## LTC

The library does not open audio devices. You deliver audio as a stream of
**PCM chunks** and the receiver follows the timecode in it:

```js
const { LtcReceiver, FrameRate } = require('timecode-tools')

const rx = new LtcReceiver({
  frameRate: FrameRate.Auto, // or a fixed rate
  offsetFrames: 0,           // latency compensation
  channel: 1,                // which channel carries LTC
})
rx.attach(pcmStream) // Readable (object mode) or async iterable of PcmChunk

rx.on('frame', (tc) => console.log(tc.toString())) // "01:02:03:04"
await rx.waitFor('01:00:10:00')                     // passes this timecode
rx.detach()
```

A chunk is a plain object:

```ts
interface PcmChunk {
  samples: Int16Array | Float32Array // interleaved; floats in -1..1
  sampleRate: number                 // Hz
  channels?: number                  // default 1
  timestamp?: number                 // ms, monotonic clock (performance.now())
}
```

`timestamp` is the time the chunk's **first sample** was captured, in a
monotonic clock such as `performance.now()`. The receiver fits a line through
these stamps to give every frame an accurate `timestamp`. If you leave it
out, the time the chunk is received is used instead. That is less precise:
it includes whatever buffering and scheduling delay happened before your
code saw the audio, and frames inherit that delay and its jitter.

`rx.level` is the recent peak input level of the LTC channel (0..1).

## MTC

`MtcReceiver` takes a stream of MIDI bytes. Chunks can be `Uint8Array`,
`Buffer` or byte arrays, or `{ bytes, timestamp }` objects with the monotonic
time (ms) the bytes arrived. Other MIDI messages, running status and
real-time bytes in between are skipped.

```js
const { MtcReceiver } = require('timecode-tools')

const rx = new MtcReceiver({ offsetFrames: 0 })
rx.attach(midiStream)
rx.on('frame', (tc) => console.log(String(tc)))
rx.on('jump', (tc) => console.log('locate', String(tc)))
```

Eight quarter-frame messages, sent over two frames, carry one timecode; the
receiver reports every frame, with `timestamp` set to when the frame began.
A full-frame message (sent by most devices when they locate) ends any chase
and is reported as a `jump`, and `rx.current` becomes the new position.

Any MIDI input library can supply the bytes. For example with
[`@julusian/midi`](https://www.npmjs.com/package/@julusian/midi):

```js
const midi = require('@julusian/midi')
const { performance } = require('node:perf_hooks')

async function* midiInput(port) {
  const input = new midi.Input()
  input.ignoreTypes(false, false, true) // receive SysEx and MTC quarter frames
  const queue = []
  let wake = null
  input.on('message', (_delta, bytes) => {
    queue.push({ bytes, timestamp: performance.now() })
    wake?.()
  })
  input.openPort(port)
  try {
    for (;;) {
      while (queue.length) yield queue.shift()
      await new Promise((resolve) => (wake = resolve))
    }
  } finally {
    input.closePort()
  }
}
rx.attach(midiInput(0))
```

## One interface for both

Code written against `TimecodeReceiver` works with either receiver:

```ts
import { LtcReceiver, MtcReceiver, type TimecodeReceiver } from 'timecode-tools'

function follow(rx: TimecodeReceiver) {
  rx.on('frame', (tc) => update(tc))
}
follow(new LtcReceiver({ channel: 2 }))
follow(new MtcReceiver())
```

| Member | |
| --- | --- |
| `attach(stream)` / `detach()` / `close()` | Connect input, disconnect it (reports `lost` if locked), or finish for good (ends iterators, rejects pending `waitFor`) |
| `frames()` / `events()` | Async iterators of frames and of `lock` / `lost` / `jump` / `end` (throws if the input fails) |
| `on` / `off` / `addEventListener` / `removeEventListener` | Events `frame`, `lock`, `lost`, `jump` |
| `waitFor(timecode)` | Resolves when playback passes the timecode |
| `positionAt(timestamp)` / `framesAt(timestamp)` | The timecode (or fractional frame count) at any instant, from a fit of the recent signal |
| `frameRate` / `detectedRate` | The configured rate / the rate in use |
| `offsetFrames` | Latency compensation; can be changed while running |
| `lostAfter` | ms without a frame before `lost` (option, default 300) |
| `locked` / `current` / `attached` / `closed` | State |
| events `end` / `error` | The attached input finished / failed |

LTC only: the `channel` option and `level`. MTC only: full-frame locates
arrive as `jump`.

## Listening

The four events are available in three styles. Use whichever fits.

### 1. EventEmitter

```js
rx.on('frame', (tc) => {})              // every frame while locked
rx.on('lock', ({ timecode, frameRate, channel }) => {})
rx.on('lost', () => {})                 // signal stopped or unreadable
rx.on('jump', (tc) => {})               // timecode jumped (relocate)
rx.off('frame', handler)
```

### 2. EventTarget style

```js
rx.addEventListener('frame', (e) => console.log(String(e.detail)))
rx.addEventListener('lock', (e) => console.log(e.detail.frameRate), { once: true })
rx.removeEventListener('frame', listener)
```

`e.detail` is what the EventEmitter listener receives. `once` and `signal`
options are supported.

### 3. Async iterators

```js
for await (const tc of rx.frames()) {
  display(tc.toString())
}

for await (const ev of rx.events()) {
  if (ev.type === 'lock') console.log('locked at', String(ev.timecode), ev.frameRate)
  if (ev.type === 'jump') console.log('jumped to', String(ev.timecode))
  if (ev.type === 'lost') console.log('lost')
  if (ev.type === 'end') break // the attached input finished
}
```

Leaving the loop (`break`, `return`, an exception) unsubscribes. If your loop
is slower than the incoming frames, older unread items are dropped and you
get the newest one; to receive everything, use `rx.frames({ buffer: 'all' })`.
Both accept a `signal` to end the iteration. `events()` also yields
`{ type: 'end' }` when the attached input finishes, and throws if the input
fails (the `error` event).

### Events

| Event | Payload | When |
| --- | --- | --- |
| `frame` | `Timecode` | Every frame on the followed timeline, while locked |
| `lock` | `{ timecode, frameRate, channel }` | The signal became stable; the first `frame` follows |
| `lost` | none | No frame for `lostAfter`, the input stopped or was detached, or (MTC) a full-frame locate |
| `jump` | `Timecode` | The timecode moved discontinuously (confirmed by two contiguous frames), or (MTC) a full-frame locate |

While locked the receiver always follows (chases) the incoming timecode. A
single corrupt frame is ignored and not reported. A frame lost to a dropout
does not break continuity.

| Event | Payload | When |
| --- | --- | --- |
| `end` | none | The attached input finished (after `lost`, if locked) |
| `error` | the error | The attached input threw |

### `waitFor(target, { signal }?)`

Resolves with the first `Timecode` at or past `target` that directly
continues a frame before it, i.e. when normal playback passes the target
(also across midnight). A jump over or onto the target does not count.
Rejects if the receiver is closed first.

### `positionAt(timestamp)` and `framesAt(timestamp)`

The timecode at any instant, not only when a frame arrives: `timestamp` is
in ms on the same monotonic clock as the chunk timestamps (for example
`performance.now()`). The receiver fits a line through the recent frames
and interpolates or extrapolates, so the result is free of the jitter of
your callbacks. `offsetFrames` is applied.

```js
const now = performance.now()
rx.positionAt(now) // Timecode (its timestamp is `now`), or null
rx.framesAt(now)   // e.g. 90048.37: frames since 00:00:00:00, not wrapped at midnight
```

Both return `null` until the signal has been locked long enough to fit,
after it is lost, and after `close()`.

## Frame rates

| Name | Rate |
| --- | --- |
| `FrameRate.Auto` | From the source (default) |
| `FrameRate.Fps24` | 24 (23.976 reads the same) |
| `FrameRate.Fps25` | 25 |
| `FrameRate.Fps2997Drop` | 29.97 drop-frame (`01:00:00;00`) |
| `FrameRate.Fps30` | 30 (29.97 non-drop reads the same) |

LTC and MTC carry the drop-frame flag but not the difference between 24 and
23.976 or between 30 and 29.97 non-drop: their labels are identical and only
the real-time speed differs.

`offsetFrames` is added to every timecode. Use a positive value when the
signal reaches you late (the usual case): the receiver then reports the
later timecode that is current by the time you act on it.

## Timecode

```js
const { Timecode, FrameRate } = require('timecode-tools')

const tc = Timecode.parse('01:00:00;00')               // ';' means drop-frame
tc.frameIndex(FrameRate.Fps2997Drop)                    // 107892
String(Timecode.fromFrameIndex(-1, FrameRate.Fps25))    // '23:59:59:24'
tc.compare(Timecode.parse('00:59:59;29'))               // 1
```

A `Timecode` has `hours`, `minutes`, `seconds`, `frames`, `dropFrame`,
`frameRate` and, when it comes from a receiver, `timestamp` (ms when it
began, in the chunks' timestamp clock).

## Low-level decoder

`LtcDecoder` has no events, timers or stream handling: push samples, get the
frames completed in that block (locked or not). It suits code that already
receives audio some other way.

```js
const { LtcDecoder } = require('timecode-tools')

const dec = new LtcDecoder({ sampleRate: 48000 }) // channels, channel, frameRate, offsetFrames
const frames = dec.push(int16Samples)            // optional 2nd argument: timestamp (ms)
// [{ timecode, locked, frameRate, sampleIndex }, ...]
```

## Getting audio in

Anything that produces PCM works. For example, from `ffmpeg` (any input it
supports, including audio interfaces):

```js
const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')

// macOS: list devices with `ffmpeg -f avfoundation -list_devices true -i ""`
const ff = spawn('ffmpeg', ['-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])

async function* chunks() {
  for await (const data of ff.stdout) {
    const samples = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)))
    yield { samples, sampleRate: 48000, timestamp: performance.now() - samples.length / 48 }
  }
}
rx.attach(chunks())
```

(A complete version, which also handles odd byte counts and MIDI input, is
the command-line example below.)

## Command-line example

[`examples/timecode-cli`](https://github.com/ShowBuildLaboratories/timecode-tools-node/tree/main/examples/timecode-cli)
shows incoming LTC or MTC on one updating terminal line. It is not part of
the npm package; run it from a checkout of this repository (after
`npm ci && npm run build`):

```sh
# LTC from a WAV file (16-bit, 24-bit or 32-bit float), in real time
node examples/timecode-cli --file ltc.wav

# LTC from an audio interface through ffmpeg (macOS), channel 2 of 2
ffmpeg -f avfoundation -i ":0" -ac 2 -ar 48000 -f s16le - \
  | node examples/timecode-cli --rate 48000 --channels 2 --channel 2

# MTC from a MIDI input (needs the optional package @julusian/midi)
node examples/timecode-cli --list-midi
node examples/timecode-cli --mtc --midi "IAC Driver Bus 1"

# Fixed frame rate and 2 frames of latency compensation
node examples/timecode-cli --file ltc.wav --fps 2997df --offset 2
```

Output, one line per event (the clock time is left out here):

```text
lock  00:59:58;03  29.97DF fps  channel 1
00:59:58;03  29.97DF  LOCKED     -4 dBFS
jump  10:00:00;01
lost
```

`node examples/timecode-cli --help` lists every option.

## Bitfocus Companion modules

The one npm package carries the binaries for every platform in its
`prebuilds/` folder and loads the right one with `process.dlopen`. That is
the layout `companion-module-build` copies into a module package, so a
Companion module built on any machine runs on every platform Companion
supports.

1. Add the dependency:

   ```sh
   npm install timecode-tools
   ```

2. `build-config.cjs`, so the build copies the binaries next to the bundle:

   ```js
   module.exports = { prebuilds: ['timecode-tools'] }
   ```

3. `companion/manifest.json`, under `runtime`:

   ```json
   "permissions": { "native-addons": true }
   ```

4. Use it from the module. Companion has no audio input of its own, so LTC
   usually comes from a separate capture process (for example `ffmpeg`, as
   in [Getting audio in](#getting-audio-in)); MTC can come from a MIDI
   library or from bytes the module already receives:

   ```js
   const { InstanceBase, runEntrypoint } = require('@companion-module/base')
   const { MtcReceiver } = require('timecode-tools')

   class TimecodeInstance extends InstanceBase {
     async init(config) {
       this.rx = new MtcReceiver({ offsetFrames: config.offset ?? 0 })
       this.rx.on('frame', (tc) => this.setVariableValues({ timecode: String(tc) }))
       this.rx.on('lock', () => this.updateStatus('ok'))
       this.rx.on('lost', () => this.updateStatus('connecting', 'No timecode'))
       this.rx.attach(midiInput(config.port)) // async iterable of MIDI bytes, see "MTC"
     }
     async destroy() {
       this.rx?.close()
     }
     // getConfigFields(), configUpdated() ...
   }
   runEntrypoint(TimecodeInstance, [])
   ```

If `timecode-tools` reports that a `.node` file was not found, the
`prebuilds/` folder was not copied next to the bundle: check step 2.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for building from source, the
golden files and the release steps.

## License

MIT, Copyright (c) 2026 Show Build Laboratories.
