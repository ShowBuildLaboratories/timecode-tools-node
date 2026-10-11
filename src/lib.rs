//! Native layer of the `timecode-tools` npm package, built with napi-rs.
//!
//! This is an internal interface: the public JavaScript API lives in
//! `index.js` and is typed by the hand-written `index.d.ts`. All timecode
//! logic (decoding, lock, jump and loss) is the Rust crate's; JavaScript adds
//! streams, events, iterators and promises.
#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::time::Duration;
use timecode_tools::{
    label::{frames_per_day as day_length, Label},
    ltc::{LtcDecoder, LtcError, PcmChunk, ReadOptions, Samples},
    mtc,
    receiver::{
        LtcReceiver, MidiChunk, MtcReceiver, ReceiverEvent, ReceiverOptions, TimecodeReceiver,
    },
    synth::{generate, SynthConfig},
    timecode::{FrameRate, Timecode},
};

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn ltc_error(e: LtcError) -> Error {
    invalid(e.to_string())
}

fn rate(name: Option<String>) -> Result<Option<FrameRate>> {
    match name.as_deref() {
        None | Some("auto") => Ok(None),
        Some(n) => FrameRate::from_name(n)
            .map(Some)
            .ok_or_else(|| invalid(format!("unknown frame rate {n:?}"))),
    }
}

fn options(frame_rate: Option<String>, offset_frames: Option<i64>) -> Result<ReadOptions> {
    Ok(ReadOptions {
        frame_rate: rate(frame_rate)?,
        offset_frames: offset_frames.unwrap_or(0),
    })
}

fn receiver_options(
    frame_rate: Option<String>,
    offset_frames: Option<i64>,
    lost_after_ms: Option<f64>,
    channel: Option<u32>,
) -> Result<ReceiverOptions> {
    let lost_after = match lost_after_ms {
        None => Duration::from_millis(300),
        Some(ms) if ms.is_finite() && ms > 0. => Duration::from_secs_f64(ms / 1e3),
        Some(_) => return Err(invalid("lostAfter must be a positive number of ms")),
    };
    let channel = match channel {
        None => Some(1),
        Some(c) if (1..=64).contains(&c) => Some(c as u8),
        Some(c) => return Err(invalid(format!("channel must be 1..64, got {c}"))),
    };
    Ok(ReceiverOptions {
        frame_rate: rate(frame_rate)?,
        offset_frames: offset_frames.unwrap_or(0),
        lost_after,
        channel,
    })
}

fn ms_to_ns(ms: Option<f64>) -> Result<Option<u64>> {
    match ms {
        None => Ok(None),
        Some(t) if t.is_finite() && t >= 0. => Ok(Some((t * 1e6).round() as u64)),
        Some(_) => Err(invalid("timestamp must be a non-negative number of ms")),
    }
}

/// A timecode as seen by the JavaScript layer.
#[napi(object)]
pub struct NativeTimecode {
    pub hours: u32,
    pub minutes: u32,
    pub seconds: u32,
    pub frames: u32,
    pub drop_frame: bool,
    /// `FrameRate` value, or null while unknown.
    pub frame_rate: Option<String>,
    pub locked: bool,
    /// Monotonic ms at which this timecode began.
    pub timestamp: Option<f64>,
    pub sample_index: Option<i64>,
    pub channel: Option<u32>,
}

fn to_js(tc: Timecode) -> NativeTimecode {
    NativeTimecode {
        hours: tc.label.hours.into(),
        minutes: tc.label.minutes.into(),
        seconds: tc.label.seconds.into(),
        frames: tc.label.frames.into(),
        drop_frame: tc.label.drop_frame,
        frame_rate: tc.frame_rate.map(|r| r.name().into()),
        locked: tc.locked,
        timestamp: tc.timestamp_ns.map(|ns| ns as f64 / 1e6),
        sample_index: tc.sample_index.map(|s| s as i64),
        channel: tc.channel,
    }
}

/// A receiver event: `kind` is `lock`, `frame`, `jump` or `lost`.
#[napi(object)]
pub struct NativeEvent {
    pub kind: String,
    pub timecode: Option<NativeTimecode>,
    /// For `frame`: index of the previous frame when playback ran on.
    pub previous: Option<i64>,
}

fn events(list: Vec<ReceiverEvent>) -> Vec<NativeEvent> {
    list.into_iter()
        .map(|e| match e {
            ReceiverEvent::Lock(tc) => NativeEvent {
                kind: "lock".into(),
                timecode: Some(to_js(tc)),
                previous: None,
            },
            ReceiverEvent::Frame { timecode, previous } => NativeEvent {
                kind: "frame".into(),
                timecode: Some(to_js(timecode)),
                previous,
            },
            ReceiverEvent::Jump(tc) => NativeEvent {
                kind: "jump".into(),
                timecode: Some(to_js(tc)),
                previous: None,
            },
            ReceiverEvent::Lost => NativeEvent {
                kind: "lost".into(),
                timecode: None,
                previous: None,
            },
        })
        .collect()
}

#[napi]
pub struct NativeLtcDecoder {
    inner: LtcDecoder,
}

#[napi]
impl NativeLtcDecoder {
    #[napi(constructor)]
    pub fn new(
        sample_rate: u32,
        channels: u32,
        channel: Option<u32>,
        frame_rate: Option<String>,
        offset_frames: Option<i64>,
    ) -> Result<Self> {
        let channels = u16::try_from(channels).map_err(|_| invalid("channels out of range"))?;
        let channel = channel
            .map(|c| u8::try_from(c).map_err(|_| invalid("channel out of range")))
            .transpose()?;
        Ok(Self {
            inner: LtcDecoder::new(
                sample_rate,
                channels,
                channel,
                options(frame_rate, offset_frames)?,
            )
            .map_err(ltc_error)?,
        })
    }

    #[napi]
    pub fn push_int16(
        &mut self,
        pcm: Int16Array,
        timestamp: Option<f64>,
    ) -> Result<Vec<NativeTimecode>> {
        let ts = ms_to_ns(timestamp)?;
        let out = self.inner.push(Samples::I16(&pcm), ts).map_err(ltc_error)?;
        Ok(out.into_iter().map(to_js).collect())
    }

    #[napi]
    pub fn push_float32(
        &mut self,
        pcm: Float32Array,
        timestamp: Option<f64>,
    ) -> Result<Vec<NativeTimecode>> {
        let ts = ms_to_ns(timestamp)?;
        let out = self.inner.push(Samples::F32(&pcm), ts).map_err(ltc_error)?;
        Ok(out.into_iter().map(to_js).collect())
    }

    #[napi(getter)]
    pub fn active_channel(&self) -> Option<u32> {
        self.inner.active_channel()
    }
    #[napi(getter)]
    pub fn locked(&self) -> bool {
        self.inner.locked()
    }
    #[napi(getter)]
    pub fn frame_rate(&self) -> Option<String> {
        self.inner.frame_rate().map(|r| r.name().into())
    }
    #[napi(getter)]
    pub fn signal_level(&self) -> f64 {
        self.inner.signal_level()
    }
    #[napi(getter)]
    pub fn samples_decoded(&self) -> i64 {
        self.inner.samples_decoded() as i64
    }
}

#[napi]
pub struct NativeLtcReceiver {
    inner: LtcReceiver,
}

#[napi]
impl NativeLtcReceiver {
    #[napi(constructor)]
    pub fn new(
        frame_rate: Option<String>,
        offset_frames: Option<i64>,
        lost_after_ms: Option<f64>,
        channel: Option<u32>,
    ) -> Result<Self> {
        Ok(Self {
            inner: LtcReceiver::new(receiver_options(
                frame_rate,
                offset_frames,
                lost_after_ms,
                channel,
            )?),
        })
    }

    #[napi]
    pub fn push_int16(
        &mut self,
        pcm: Int16Array,
        sample_rate: u32,
        channels: u32,
        timestamp: f64,
    ) -> Result<Vec<NativeEvent>> {
        self.push(Samples::I16(&pcm), sample_rate, channels, timestamp)
    }

    #[napi]
    pub fn push_float32(
        &mut self,
        pcm: Float32Array,
        sample_rate: u32,
        channels: u32,
        timestamp: f64,
    ) -> Result<Vec<NativeEvent>> {
        self.push(Samples::F32(&pcm), sample_rate, channels, timestamp)
    }

    #[napi]
    pub fn signal_lost(&mut self) -> Vec<NativeEvent> {
        events(self.inner.signal_lost())
    }

    #[napi(getter)]
    pub fn locked(&self) -> bool {
        self.inner.locked()
    }
    #[napi(getter)]
    pub fn detected_rate(&self) -> Option<String> {
        self.inner.detected_rate().map(|r| r.name().into())
    }
    #[napi(getter)]
    pub fn level(&self) -> f64 {
        self.inner.level()
    }
    #[napi(getter)]
    pub fn offset_frames(&self) -> i64 {
        self.inner.offset_frames()
    }
    #[napi(setter)]
    pub fn set_offset_frames(&mut self, frames: i64) {
        self.inner.set_offset_frames(frames);
    }
    /// Fractional frame count since 00:00:00:00 at `timestamp` (ms, the
    /// chunk timestamp clock), offset applied; `null` until fitted.
    #[napi]
    pub fn frames_at(&self, timestamp: f64) -> Result<Option<f64>> {
        Ok(ms_to_ns(Some(timestamp))?.and_then(|ns| self.inner.frames_at(ns)))
    }
}

impl NativeLtcReceiver {
    fn push(
        &mut self,
        samples: Samples<'_>,
        sample_rate: u32,
        channels: u32,
        timestamp: f64,
    ) -> Result<Vec<NativeEvent>> {
        let channels = u16::try_from(channels).map_err(|_| invalid("channels out of range"))?;
        let chunk = PcmChunk {
            samples,
            sample_rate,
            channels,
            timestamp_ns: ms_to_ns(Some(timestamp))?,
        };
        Ok(events(self.inner.push(chunk).map_err(ltc_error)?))
    }
}

#[napi]
pub struct NativeMtcReceiver {
    inner: MtcReceiver,
}

#[napi]
impl NativeMtcReceiver {
    #[napi(constructor)]
    pub fn new(
        frame_rate: Option<String>,
        offset_frames: Option<i64>,
        lost_after_ms: Option<f64>,
    ) -> Result<Self> {
        Ok(Self {
            inner: MtcReceiver::new(receiver_options(
                frame_rate,
                offset_frames,
                lost_after_ms,
                None,
            )?),
        })
    }

    #[napi]
    pub fn push(&mut self, bytes: Uint8Array, timestamp: f64) -> Result<Vec<NativeEvent>> {
        let chunk = MidiChunk {
            data: &bytes,
            timestamp_ns: ms_to_ns(Some(timestamp))?.unwrap(),
        };
        match self.inner.push(chunk) {
            Ok(list) => Ok(events(list)),
            Err(never) => match never {},
        }
    }

    #[napi]
    pub fn signal_lost(&mut self) -> Vec<NativeEvent> {
        events(self.inner.signal_lost())
    }

    #[napi(getter)]
    pub fn locked(&self) -> bool {
        self.inner.locked()
    }
    #[napi(getter)]
    pub fn detected_rate(&self) -> Option<String> {
        self.inner.detected_rate().map(|r| r.name().into())
    }
    #[napi(getter)]
    pub fn offset_frames(&self) -> i64 {
        self.inner.offset_frames()
    }
    #[napi(setter)]
    pub fn set_offset_frames(&mut self, frames: i64) {
        self.inner.set_offset_frames(frames);
    }
    /// Fractional frame count since 00:00:00:00 at `timestamp` (ms, the
    /// chunk timestamp clock), offset applied; `null` until fitted.
    #[napi]
    pub fn frames_at(&self, timestamp: f64) -> Result<Option<f64>> {
        Ok(ms_to_ns(Some(timestamp))?.and_then(|ns| self.inner.frames_at(ns)))
    }
}

/// Timecode label fields.
#[napi(object)]
pub struct NativeLabel {
    pub hours: u32,
    pub minutes: u32,
    pub seconds: u32,
    pub frames: u32,
    pub drop_frame: bool,
}

fn check_fps(fps: u32) -> Result<()> {
    if [24, 25, 30].contains(&fps) {
        Ok(())
    } else {
        Err(invalid(format!("fps must be 24, 25 or 30, got {fps}")))
    }
}

fn to_label(label: NativeLabel) -> Result<Label> {
    let field = |v: u32| u8::try_from(v).map_err(|_| invalid("timecode field out of range"));
    Ok(Label {
        hours: field(label.hours)?,
        minutes: field(label.minutes)?,
        seconds: field(label.seconds)?,
        frames: field(label.frames)?,
        drop_frame: label.drop_frame,
    })
}

/// Frame count since 00:00:00:00 for a label (no validation of the label).
#[napi]
pub fn frame_index(label: NativeLabel, fps: u32) -> Result<i64> {
    check_fps(fps)?;
    Ok(to_label(label)?.frame_index(fps))
}

/// Label for a frame count, wrapping around one day.
#[napi]
pub fn label_from_index(index: i64, fps: u32, drop_frame: bool) -> Result<NativeLabel> {
    check_fps(fps)?;
    let l = Label::from_index(index, fps, drop_frame);
    Ok(NativeLabel {
        hours: l.hours.into(),
        minutes: l.minutes.into(),
        seconds: l.seconds.into(),
        frames: l.frames.into(),
        drop_frame: l.drop_frame,
    })
}

#[napi]
pub fn frames_per_day(fps: u32, drop_frame: bool) -> Result<i64> {
    check_fps(fps)?;
    Ok(day_length(fps, drop_frame))
}

// Test-signal helpers (used by the package's tests; not public API).

/// Mono 16-bit LTC test signal.
#[napi]
pub fn generate_ltc(
    sample_rate: u32,
    frame_rate: String,
    start_index: i64,
    frame_count: u32,
    amplitude: f64,
) -> Result<Int16Array> {
    let rate = rate(Some(frame_rate))?.ok_or_else(|| invalid("a fixed frame rate is required"))?;
    if !(0. ..=1.).contains(&amplitude) || frame_count > 24 * 3600 * 30 {
        return Err(invalid("amplitude or frameCount out of range"));
    }
    let signal = generate(SynthConfig {
        sample_rate,
        rate: rate.fps(),
        nominal_fps: rate.nominal_fps(),
        drop_frame: rate.drop_frame(),
        start_index,
        frame_count: frame_count as usize,
        amplitude: amplitude * 32767.,
        ..Default::default()
    });
    Ok(Int16Array::new(signal.pcm))
}

/// MTC test data: quarter-frame messages and their send times.
#[napi(object)]
pub struct NativeMtcStream {
    /// Concatenated two-byte quarter-frame messages.
    pub bytes: Uint8Array,
    /// Send time of each message in ms, from 0.
    pub times: Float64Array,
}

#[napi]
pub fn generate_mtc(
    frame_rate: String,
    start_index: i64,
    frame_count: u32,
) -> Result<NativeMtcStream> {
    let rate = rate(Some(frame_rate))?.ok_or_else(|| invalid("a fixed frame rate is required"))?;
    if frame_count > 24 * 3600 * 30 {
        return Err(invalid("frameCount must be at most one day"));
    }
    let messages = mtc::quarter_frames(rate, start_index, frame_count as usize);
    let bytes: Vec<u8> = messages.iter().flat_map(|(m, _)| *m).collect();
    let times: Vec<f64> = messages.iter().map(|(_, t)| *t as f64 / 1e6).collect();
    Ok(NativeMtcStream {
        bytes: Uint8Array::new(bytes),
        times: Float64Array::new(times),
    })
}

/// Full-frame SysEx message for a label.
#[napi]
pub fn mtc_full_frame(frame_rate: String, label: NativeLabel) -> Result<Uint8Array> {
    let rate = rate(Some(frame_rate))?.ok_or_else(|| invalid("a fixed frame rate is required"))?;
    let label = Label {
        drop_frame: rate.drop_frame(),
        ..to_label(label)?
    };
    Ok(Uint8Array::new(mtc::full_frame(rate, label).to_vec()))
}
