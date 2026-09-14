//! Recording the session to a WAV file.
//!
//! **Nothing here touches the disk on the audio thread.** The render callback
//! appends interleaved frames into a buffer whose capacity is fixed before the
//! recording starts, and a writer thread swaps that buffer out every 50 ms and
//! writes what it took. That swap is the only thing either thread does under
//! the lock, so the audio thread's worst case is a pointer exchange -- the same
//! contract `get_samples` has with the display buffers, and the same reason
//! `stretch.rs` renders off-thread and swaps the result in.
//!
//! Streamed rather than accumulated: a practice session is long, and a buffer
//! sized for one would be the recording's real limit.
//!
//! **32-bit float, not 16-bit PCM.** The output bus leaves the callback as
//! `audio_out * 12.0` and nothing clamps it, so 16-bit would mean choosing a
//! clip point and silently ruining a take that crossed it. Float stores what
//! was actually summed and costs a `fact` chunk and 14 bytes of header over the
//! canonical 44.
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::constants::sample_rate;

/// How much the callback can get ahead of the writer before a frame is
/// dropped. Forty flush intervals, so it only ever fires if the disk has
/// genuinely stopped answering -- at which point dropping is the only choice
/// that isn't "stall the audio thread".
const RING_SECONDS: f64 = 2.0;

/// How often the writer drains. Short enough that a stop lands promptly, long
/// enough that the file is written in blocks rather than in dribs.
const FLUSH_MS: u64 = 50;

/// RIFF + fmt (18, with cbSize) + fact + data headers.
pub const HEADER_LEN: usize = 58;

const FORMAT_IEEE_FLOAT: u16 = 3;
const BYTES_PER_SAMPLE: u32 = 4;

/// The whole header, for `frames` of audio. Written once with a frame count of
/// zero and then *rewritten* -- rather than patching the three size fields
/// individually -- every time the writer flushes, so a file left behind by a
/// crash is readable up to the last drain rather than being 58 bytes of zeroes.
pub fn wav_header(channels: u16, rate: u32, frames: u64) -> [u8; HEADER_LEN] {
    let block_align = channels.max(1) as u32 * BYTES_PER_SAMPLE;
    // A WAV cannot describe more than 4 GB, so the sizes saturate rather than
    // wrapping into a number that would make the file unreadable from the
    // start. The audio already on disk still plays; only the tail is lost.
    let data_bytes = frames
        .saturating_mul(block_align as u64)
        .min(u32::MAX as u64 - (HEADER_LEN as u64 - 8)) as u32;

    let mut h = [0u8; HEADER_LEN];
    let mut put = |at: usize, bytes: &[u8]| h[at..at + bytes.len()].copy_from_slice(bytes);
    put(0, b"RIFF");
    put(4, &(HEADER_LEN as u32 - 8 + data_bytes).to_le_bytes());
    put(8, b"WAVE");
    put(12, b"fmt ");
    put(16, &18u32.to_le_bytes());
    put(20, &FORMAT_IEEE_FLOAT.to_le_bytes());
    put(22, &channels.to_le_bytes());
    put(24, &rate.to_le_bytes());
    put(28, &(rate * block_align).to_le_bytes());
    put(32, &(block_align as u16).to_le_bytes());
    put(34, &((BYTES_PER_SAMPLE * 8) as u16).to_le_bytes());
    put(36, &0u16.to_le_bytes());
    // Required for a non-PCM format: how many frames the data chunk holds.
    put(38, b"fact");
    put(42, &4u32.to_le_bytes());
    put(46, &(frames.min(u32::MAX as u64) as u32).to_le_bytes());
    put(50, b"data");
    put(54, &data_bytes.to_le_bytes());
    h
}

pub struct WavFile {
    file: BufWriter<File>,
    channels: u16,
    rate: u32,
    pub frames: u64,
    /// Reused so a flush doesn't allocate a block's worth of bytes every time.
    bytes: Vec<u8>,
}

impl WavFile {
    /// Created on the *command's* thread, before the callback is ever told to
    /// record: a bad path, a read-only disk or a missing directory is then a
    /// failed command with a message, rather than something the audio thread
    /// discovers and has no way to report.
    pub fn create(path: &str, channels: u16, rate: u32) -> Result<Self, String> {
        let file = File::create(path).map_err(|e| format!("{}: {}", path, e))?;
        let mut wav = WavFile {
            file: BufWriter::new(file),
            channels: channels.max(1),
            rate,
            frames: 0,
            bytes: Vec::new(),
        };
        wav.rewrite_header()?;
        // Flushed here rather than left in the `BufWriter`, so a disk that is
        // already full fails this command instead of a flush half a minute
        // later, and so the file on disk is a valid empty WAV from the start.
        wav.file.flush().map_err(|e| e.to_string())?;
        Ok(wav)
    }

    fn rewrite_header(&mut self) -> Result<(), String> {
        let header = wav_header(self.channels, self.rate, self.frames);
        self.file.write_all(&header).map_err(|e| e.to_string())
    }

    pub fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        self.bytes.clear();
        self.bytes.reserve(samples.len() * BYTES_PER_SAMPLE as usize);
        for s in samples {
            self.bytes.extend_from_slice(&s.to_le_bytes());
        }
        self.file.write_all(&self.bytes).map_err(|e| e.to_string())?;
        self.frames += (samples.len() / self.channels as usize) as u64;
        Ok(())
    }

    /// Seeks back over the header with the real frame count and returns to the
    /// end. `BufWriter` flushes on seek, so nothing is written out of order.
    pub fn patch(&mut self) -> Result<(), String> {
        self.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.rewrite_header()?;
        self.file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.patch()?;
        self.file.flush().map_err(|e| e.to_string())
    }
}

/// What the callback appends to. Its capacity is fixed at `start` and never
/// grows: a full buffer drops the frame and counts it, because the alternative
/// -- reallocating, or waiting for the writer -- is the audio thread reaching
/// for the allocator or the disk.
pub struct RecordBuffer {
    samples: Vec<f32>,
    dropped_frames: u64,
    input_channels: usize,
    record_input: bool,
    record_output: bool,
}

impl RecordBuffer {
    fn idle() -> Self {
        RecordBuffer {
            samples: Vec::new(),
            dropped_frames: 0,
            input_channels: 0,
            record_input: false,
            record_output: false,
        }
    }

    pub fn channels(&self) -> usize {
        (if self.record_input { self.input_channels } else { 0 })
            + if self.record_output { 2 } else { 0 }
    }

    /// One frame: every input channel, then the two sides of the output mix.
    /// With both switches on the file is `inputs + 2` channels wide rather than
    /// two files or a sum -- one dialog answers with one file, and nothing that
    /// you might want apart is mixed together.
    pub fn push_frame(&mut self, input: &[f32], out: [f32; 2]) {
        let width = self.channels();
        if width == 0 {
            return;
        }
        // Capacity, not length: `Vec::push` only allocates when it is full, and
        // this is the check that keeps it from ever being.
        if self.samples.len() + width > self.samples.capacity() {
            self.dropped_frames += 1;
            return;
        }
        if self.record_input {
            for ch in 0..self.input_channels {
                self.samples.push(input.get(ch).copied().unwrap_or(0.0));
            }
        }
        if self.record_output {
            self.samples.push(out[0]);
            self.samples.push(out[1]);
        }
    }
}

/// What the panel polls. Frames rather than bytes, since the rate is the
/// device's; `dropped_frames` is here so an overrun is visible rather than a
/// silent gap in a take.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub recording: bool,
    pub path: String,
    pub channels: usize,
    pub frames: u64,
    pub seconds: f64,
    pub dropped_frames: u64,
    /// Empty unless the writer thread failed. A disk error cannot be reported
    /// to the audio thread, so it is left here for the next poll.
    pub error: String,
}

#[derive(Default)]
struct Info {
    path: String,
    channels: usize,
    error: String,
}

pub struct Recorder {
    /// Fixed at launch, like every other per-channel buffer in the callback.
    input_channels: usize,
    /// Read by the callback before it takes any lock at all, so a session that
    /// is not recording costs one relaxed load a callback.
    armed: AtomicBool,
    stopping: AtomicBool,
    buffer: Mutex<RecordBuffer>,
    frames_written: AtomicU64,
    /// Mirrored out of the buffer by the writer on each flush, so polling the
    /// status never takes the lock the audio thread is using.
    dropped: AtomicU64,
    info: Mutex<Info>,
    writer: Mutex<Option<std::thread::JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        // A poisoned lock is still a buffer of samples; refusing to record
        // because a thread panicked elsewhere helps nobody.
        Err(e) => e.into_inner(),
    }
}

impl Recorder {
    pub fn new(input_channels: usize) -> Self {
        Recorder {
            input_channels,
            armed: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            buffer: Mutex::new(RecordBuffer::idle()),
            frames_written: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            info: Mutex::new(Info::default()),
            writer: Mutex::new(None),
        }
    }

    pub fn armed(&self) -> bool {
        self.armed.load(Ordering::Relaxed)
    }

    /// Taken once per callback, never per frame -- and only while a recording
    /// is running.
    pub fn lock_buffer(&self) -> MutexGuard<'_, RecordBuffer> {
        lock(&self.buffer)
    }

    pub fn start(
        self: &Arc<Self>,
        path: &str,
        record_input: bool,
        record_output: bool,
    ) -> Result<(), String> {
        if self.armed() {
            return Err("already recording".into());
        }
        // A previous run's thread has always been joined by `stop`, but a
        // writer that failed on its own returns without being asked to.
        self.join_writer();

        let channels = (if record_input { self.input_channels } else { 0 })
            + if record_output { 2 } else { 0 };
        if channels == 0 {
            return Err("nothing to record: choose the input, the output, or both".into());
        }
        let rate = sample_rate();
        let wav = WavFile::create(path, channels as u16, rate as u32)?;

        let capacity = (RING_SECONDS * rate) as usize * channels;
        {
            let mut buf = lock(&self.buffer);
            *buf = RecordBuffer {
                samples: Vec::with_capacity(capacity),
                dropped_frames: 0,
                input_channels: self.input_channels,
                record_input,
                record_output,
            };
        }
        self.frames_written.store(0, Ordering::Relaxed);
        self.dropped.store(0, Ordering::Relaxed);
        *lock(&self.info) = Info {
            path: path.to_string(),
            channels,
            error: String::new(),
        };
        self.stopping.store(false, Ordering::Relaxed);
        self.armed.store(true, Ordering::Release);

        let me = self.clone();
        *lock(&self.writer) = Some(std::thread::spawn(move || me.run_writer(wav, capacity)));
        Ok(())
    }

    /// Idempotent: stopping twice, or stopping something that was never
    /// started, answers with the status and does nothing else.
    pub fn stop(&self) -> RecordingStatus {
        self.armed.store(false, Ordering::Release);
        self.stopping.store(true, Ordering::Relaxed);
        self.join_writer();
        self.status()
    }

    pub fn status(&self) -> RecordingStatus {
        let info = lock(&self.info);
        let frames = self.frames_written.load(Ordering::Relaxed);
        let rate = sample_rate();
        RecordingStatus {
            recording: self.armed(),
            path: info.path.clone(),
            channels: info.channels,
            frames,
            seconds: if rate > 0.0 { frames as f64 / rate } else { 0.0 },
            dropped_frames: self.dropped.load(Ordering::Relaxed),
            error: info.error.clone(),
        }
    }

    fn join_writer(&self) {
        // Taken out from under the lock before joining, so nothing else can be
        // waiting on `writer` for as long as the join takes.
        let handle = lock(&self.writer).take();
        if let Some(h) = handle {
            let _ = h.join();
        }
    }

    fn fail(&self, message: String) {
        // Disarmed first: the callback must stop pushing into a buffer nobody
        // is going to drain.
        self.armed.store(false, Ordering::Release);
        lock(&self.info).error = message;
    }

    /// Swap, write, patch. The lock is held for the swap alone, which is what
    /// keeps the audio thread's worst case at a pointer exchange rather than a
    /// disk write.
    fn drain(&self, wav: &mut WavFile, spare: &mut Vec<f32>) -> Result<(), String> {
        let dropped = {
            let mut buf = lock(&self.buffer);
            std::mem::swap(&mut buf.samples, spare);
            buf.dropped_frames
        };
        self.dropped.store(dropped, Ordering::Relaxed);
        if !spare.is_empty() {
            wav.write(spare)?;
            self.frames_written.store(wav.frames, Ordering::Relaxed);
            wav.patch()?;
        }
        // Emptied but not freed: this vector goes back to the callback on the
        // next swap, and it has to arrive with its capacity intact.
        spare.clear();
        Ok(())
    }

    fn run_writer(&self, mut wav: WavFile, capacity: usize) {
        // The other half of the pair. Two buffers, both allocated before the
        // recording starts, exchanged for ever after.
        let mut spare: Vec<f32> = Vec::with_capacity(capacity);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(FLUSH_MS));
            // Read before the drain, so the drain that follows a stop is the
            // last one and nothing pushed before it is lost.
            let stopping = self.stopping.load(Ordering::Relaxed);
            if let Err(e) = self.drain(&mut wav, &mut spare) {
                self.fail(e);
                return;
            }
            if stopping {
                break;
            }
        }
        // One more for whatever the callback pushed between the last swap and
        // the flag being seen.
        if let Err(e) = self.drain(&mut wav, &mut spare).and_then(|_| wav.finish()) {
            self.fail(e);
        }
    }
}
