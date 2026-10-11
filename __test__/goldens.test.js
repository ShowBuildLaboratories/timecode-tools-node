'use strict'
// Replays the shared receiver golden files (goldens/, copied from the Rust
// core repository) through the public Node API: the same frames (timecode,
// and timestamp within 3 us), the same lock / lost / jump events after each
// input chunk, the same waitFor() results and the same final state.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LtcReceiver, MtcReceiver } = require('..')
const { referenceLtc } = require('./helpers/reference-ltc.js')
const goldens = require('../scripts/goldens.js')

const NOMINAL = { 24: 24, 25: 25, '29.97df': 30, 30: 30 }

test('goldens/ matches its SHA256SUMS', () => {
  assert.deepEqual(goldens.checkSums(), [])
})

test('goldens/ is an exact copy of the core goldens', (t) => {
  const problems = goldens.checkCore()
  if (problems === null) return t.skip(`no goldens/ in the core checkout at ${goldens.coreDir()}`)
  assert.deepEqual(problems, [])
})

test('the copy check reports a changed, missing or extra file', () => {
  const os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldens-core-'))
  try {
    fs.cpSync(goldens.LOCAL, path.join(dir, 'goldens'), { recursive: true })
    fs.rmSync(path.join(dir, 'goldens', 'SHA256SUMS'))
    assert.deepEqual(goldens.checkCore(dir), [])
    const files = fs
      .readdirSync(path.join(dir, 'goldens'), { recursive: true })
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.split(path.sep).join('/'))
      .sort()
    fs.appendFileSync(path.join(dir, 'goldens', files[0]), ' ')
    fs.rmSync(path.join(dir, 'goldens', files[1]))
    fs.writeFileSync(path.join(dir, 'goldens', 'new.json'), '{}')
    assert.deepEqual(goldens.checkCore(dir).sort(), [
      `goldens/${files[0]} differs from the core`,
      `goldens/${files[1]} is not in the core`,
      'goldens/new.json is missing (present in the core)',
    ].sort())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Receiver goldens: every JSON file under goldens/ with kind "ltc" or "mtc".
function receiverGoldens() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.json')) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'))
        if ((data.kind === 'ltc' || data.kind === 'mtc') && Array.isArray(data.steps)) out.push(data)
      }
    }
  }
  walk(goldens.LOCAL)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function receiverOptions(o) {
  const options = { offsetFrames: o.offset_frames ?? 0 }
  if (o.frame_rate) options.frameRate = o.frame_rate.toLowerCase()
  if (o.channel) options.channel = o.channel
  return options
}

function ltcChunks(input) {
  const rate = input.rate.toLowerCase()
  const parts = input.segments.map((seg) =>
    seg.silence != null
      ? new Int16Array(seg.silence)
      : referenceLtc({
          sampleRate: input.sample_rate,
          frameRate: rate,
          nominalFps: NOMINAL[rate],
          start: seg.start,
          frameCount: seg.frame_count,
        }),
  )
  const mono = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (mono.set(p, at), at + p.length), 0)
  const channels = input.channels
  let pcm = mono
  if (channels > 1) {
    pcm = new Int16Array(mono.length * channels)
    for (let i = 0; i < mono.length; i++) {
      for (let c = 1; c <= channels; c++) {
        pcm[i * channels + c - 1] = c === input.ltc_channel ? mono[i] : ((i * 37) % 4000) - 2000
      }
    }
  }
  assert.equal(pcm.length, input.sample_count, 'LTC input length')
  const per = input.chunk * channels
  const chunks = []
  for (let at = 0; at < pcm.length; at += per) {
    const first = at / channels
    const us = input.t0_us + Math.round((first * 1e6) / input.sample_rate)
    chunks.push({ samples: pcm.subarray(at, at + per), sampleRate: input.sample_rate, channels, timestamp: us / 1000 })
  }
  return chunks
}

function mtcChunks(input) {
  return input.chunks.map((c) => ({ bytes: Buffer.from(c.bytes, 'hex'), timestamp: c.t_us / 1000 }))
}

function checkTimestamp(tc, wantUs, context) {
  if (wantUs == null) return assert.equal(tc.timestamp, null, context)
  assert.ok(Math.abs(tc.timestamp * 1000 - wantUs) <= 3, `${context}: timestamp ${tc.timestamp} ms vs ${wantUs} us`)
}

const cases = receiverGoldens()

test('receiver goldens are present', () => {
  assert.ok(cases.length >= 7, `found ${cases.length} receiver goldens`)
})

for (const golden of cases) {
  test(`golden ${golden.name}`, async () => {
    const name = golden.name
    const rx = golden.kind === 'ltc' ? new LtcReceiver(receiverOptions(golden.options)) : new MtcReceiver(receiverOptions(golden.options))
    const chunks = golden.kind === 'ltc' ? ltcChunks(golden.input) : mtcChunks(golden.input)

    const steps = []
    const chunkOf = new WeakMap()
    rx.on('frame', (tc) => {
      steps.at(-1).frames.push(tc)
      chunkOf.set(tc, steps.length - 1)
    })
    for (const type of ['lock', 'lost', 'jump']) rx.on(type, () => steps.at(-1).events.push(type))

    const waits = {}
    for (const target of Object.keys(golden.wait_for)) {
      waits[target] = null
      rx.waitFor(target).then(
        (tc) => (waits[target] = tc),
        () => {},
      )
    }

    let final
    const ended = new Promise((resolve) => rx.once('end', resolve))
    rx.attach(
      (async function* () {
        for (const chunk of chunks) {
          steps.push({ frames: [], events: [] })
          yield chunk
        }
        // State after the last chunk, before end-of-input reports 'lost'.
        final = { locked: rx.locked, detectedRate: rx.detectedRate, current: rx.current ? String(rx.current) : null }
        steps.push({ frames: [], events: [], afterInput: true })
      })(),
    )
    await ended
    await new Promise((r) => setImmediate(r))

    const after = steps.pop()
    assert.ok(after.afterInput)
    assert.deepEqual(after.events, golden.final_locked ? ['lost'] : [], `${name}: end of input`)
    assert.equal(steps.length, golden.steps.length, `${name}: chunk count`)
    golden.steps.forEach((want, i) => {
      const got = steps[i]
      assert.deepEqual(got.events, want.events, `${name} chunk ${i}: events`)
      assert.equal(got.frames.length, want.frames.length, `${name} chunk ${i}: frame count`)
      got.frames.forEach((tc, k) => {
        assert.equal(String(tc), want.frames[k].tc, `${name} chunk ${i}`)
        checkTimestamp(tc, want.frames[k].ts_us, `${name} chunk ${i} ${tc}`)
      })
    })
    for (const [target, want] of Object.entries(golden.wait_for)) {
      const got = waits[target]
      if (want === null) {
        assert.equal(got, null, `${name} waitFor ${target}`)
        continue
      }
      assert.ok(got, `${name} waitFor ${target}: not resolved`)
      assert.equal(chunkOf.get(got), want.chunk, `${name} waitFor ${target}: chunk`)
      assert.equal(String(got), want.tc, `${name} waitFor ${target}`)
      checkTimestamp(got, want.ts_us, `${name} waitFor ${target}`)
    }
    assert.equal(final.locked, golden.final_locked, `${name}: locked`)
    assert.equal(final.detectedRate, golden.final_detected_rate?.toLowerCase() ?? null, `${name}: rate`)
    assert.equal(final.current, golden.final_current, `${name}: current`)
    rx.close()
  })
}
