// Compile-only check of index.d.ts (npm run typecheck).
import {
  FrameRate,
  LtcDecoder,
  LtcReceiver,
  MtcReceiver,
  Timecode,
  TimecodeReceiver,
  type MidiChunk,
  type PcmChunk,
} from '..'

// The same code works with either receiver.
function follow(rx: TimecodeReceiver) {
  rx.on('frame', (tc) => tc.toString())
  rx.on('lock', (info) => info.frameRate satisfies '24' | '25' | '29.97df' | '30')
  rx.on('lost', () => {})
  rx.on('jump', (tc) => tc.frameIndex())
  rx.addEventListener('frame', (e) => e.detail.compare(Timecode.parse('01:00:00:00')))
  rx.offsetFrames = -2
  const rate: FrameRate = rx.frameRate
  const detected: '24' | '25' | '29.97df' | '30' | null = rx.detectedRate
  void rate
  void detected
  const at: Timecode | null = rx.positionAt(performance.now())
  const frames: number | null = rx.framesAt(performance.now())
  void at
  void frames
  return rx.waitFor('01:00:10:00')
}

const ltc = new LtcReceiver({ frameRate: FrameRate.Auto, offsetFrames: 0, channel: 1, lostAfter: 300 })
const mtc = new MtcReceiver({ offsetFrames: 0 })
void follow(ltc)
void follow(mtc)
const level: number = ltc.level
void level
void (ltc instanceof TimecodeReceiver)

async function* pcm(): AsyncGenerator<PcmChunk> {
  yield { samples: new Int16Array(480), sampleRate: 48000, timestamp: 0 }
}
async function* midi(): AsyncGenerator<MidiChunk> {
  yield { bytes: [0xf1, 0x00], timestamp: performance.now() }
  yield new Uint8Array([0xf1, 0x10])
}
ltc.attach(pcm())
mtc.attach(midi())

async function iterate(rx: TimecodeReceiver) {
  for await (const tc of rx.frames({ buffer: 'all' })) tc.frameIndex()
  for await (const ev of rx.events()) {
    if (ev.type === 'lock') ev.channel satisfies number | null
    else if (ev.type === 'jump') ev.timecode.toString()
  }
}
void iterate
ltc.detach()
mtc.close()

const dec = new LtcDecoder({ sampleRate: 48000 })
for (const f of dec.push(new Float32Array(480), performance.now())) {
  f.timecode.toString()
  f.locked satisfies boolean
  f.sampleIndex satisfies number
}
// @ts-expect-error numbers are not frame rates
new LtcDecoder({ sampleRate: 48000, frameRate: 25 })
// @ts-expect-error PCM is not MIDI
mtc.attach(pcm())
