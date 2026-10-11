# Changelog

All notable changes to the npm package `timecode-tools` are documented here.
Its version follows the Rust crate
[`timecode-tools`](https://crates.io/crates/timecode-tools) it is built on.
This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 - Unreleased

First public release.

- `LtcReceiver` (PCM chunks) and `MtcReceiver` (MIDI bytes), sharing the
  `TimecodeReceiver` interface: `attach` / `detach` / `close`, events
  `frame`, `lock`, `lost` and `jump` through EventEmitter,
  `addEventListener` or async iterators (`frames()`, `events()`),
  `waitFor(timecode)`, `positionAt(timestamp)` and `framesAt(timestamp)`
  (the timecode at any instant, from a fit of the signal), `frameRate`,
  `detectedRate`, `offsetFrames`, `lostAfter`, `closed`; `end` and `error` for the attached input (also
  through `events()`).
- `LtcDecoder`: low-level `push()` returning decoded frames.
- `Timecode` parsing, formatting, `compare` and frame arithmetic;
  `FrameRate` names.
- TypeScript definitions.
- Prebuilt binaries for macOS (arm64, x64), Windows (x64, arm64) and Linux
  (x64, arm64, armv7; glibc and musl), all inside the one package.
- Results checked against the shared golden files of the Rust core.
- `examples/timecode-cli`: terminal LTC and MTC reader for WAV files, raw
  PCM or MIDI bytes on standard input, and MIDI inputs.
