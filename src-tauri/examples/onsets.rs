//! The onset picker, run over a file instead of over a microphone.
//!
//! There was no way to ask "where does this algorithm say the notes are" about
//! anything but live audio, which makes it untestable against material you can
//! look at -- and where the onsets land is the one thing in this app that has
//! never been right. This drives the *real* `Analyzer` frame by frame in
//! exactly the order `main.rs` does, so what it reports is what the app would
//! have drawn.
//!
//! An `examples/` target rather than a second `[[bin]]`, deliberately: cargo
//! builds examples only when asked, so `yarn tauri build` neither compiles this
//! nor gains its warnings.
//!
//!   cargo run --release --example onsets -- analyze take.wav
//!   cargo run --release --example onsets -- analyze take.wav --expect 4410,22050
//!   cargo run --release --example onsets -- synth ../src-tauri/samples/kick.wav \
//!       --at 10000,30000,52000
//!
//! `synth` is the half that needs nobody's recording: it places a sample at
//! frames it chooses, so the ground truth is exact by construction rather than
//! measured off a picture. That is what the drums bus was always for -- the
//! callback knows its own trigger times -- and it settles the systematic bias
//! before any instrument is involved.

use std::env;
use std::fs;

#[path = "../src/analysis.rs"]
mod analysis;

/// A stand-in for the real one. `analysis.rs` is the only thing being tested
/// here and `Onset` is all it wants from the crate; including the real
/// `structs.rs` would drag in the config, Core Audio and half the app. Same
/// shape, so the arithmetic under test is untouched -- and if the real one ever
/// gains a field this stops compiling, which is the right kind of failure.
mod structs {
    #[derive(Clone, Copy, Debug)]
    pub struct Onset {
        pub beat: f64,
        pub channel: usize,
        pub strength: f32,
    }
}

use analysis::{Analyzer, OnsetParams, MAX_ANALYSIS_CHANNELS};
use structs::Onset;

// ---------------------------------------------------------------- WAV reading

struct Wav {
    /// Interleaved.
    samples: Vec<f32>,
    rate: f64,
    channels: usize,
}

impl Wav {
    fn frames(&self) -> usize {
        self.samples.len() / self.channels.max(1)
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Enough of RIFF to read what this app writes and what a DAW bounces: PCM at
/// 16, 24 or 32 bits, and 32-bit float. Written out rather than reached for
/// through symphonia because that path goes through `constants::sample_rate`,
/// a process-global `OnceLock` -- and a harness whose whole job is to measure
/// timing has no business inheriting a rate from anywhere but the file.
fn read_wav(path: &str) -> Result<Wav, String> {
    let b = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(format!("{path} is not a WAV"));
    }
    let (mut format, mut channels, mut rate, mut bits) = (1u16, 0usize, 0f64, 0u16);
    let mut data: Option<(usize, usize)> = None;
    let mut at = 12;
    while at + 8 <= b.len() {
        let id = &b[at..at + 4];
        let size = u32_at(&b, at + 4) as usize;
        let body = at + 8;
        if body + size > b.len() && id != b"data" {
            break;
        }
        if id == b"fmt " && size >= 16 {
            format = u16_at(&b, body);
            channels = u16_at(&b, body + 2) as usize;
            rate = u32_at(&b, body + 4) as f64;
            bits = u16_at(&b, body + 14);
            // WAVE_FORMAT_EXTENSIBLE hides the real format in a sub-GUID whose
            // first two bytes are the ordinary tag.
            if format == 0xFFFE && size >= 26 {
                format = u16_at(&b, body + 24);
            }
        } else if id == b"data" {
            // A file left behind by a crash can name more data than it holds;
            // take what is actually there rather than refusing the take.
            data = Some((body, size.min(b.len().saturating_sub(body))));
        }
        at = body + size + (size & 1);
    }
    let (start, len) = data.ok_or_else(|| format!("{path} has no data chunk"))?;
    if channels == 0 || rate <= 0.0 {
        return Err(format!("{path} has no usable fmt chunk"));
    }
    let bytes = (bits as usize) / 8;
    if bytes == 0 {
        return Err(format!("{path}: {bits}-bit is not something this reads"));
    }
    let n = len / bytes;
    let mut samples = Vec::with_capacity(n);
    for i in 0..n {
        let o = start + i * bytes;
        let v = match (format, bits) {
            (3, 32) => f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]),
            (1, 16) => i16::from_le_bytes([b[o], b[o + 1]]) as f32 / 32768.0,
            (1, 24) => {
                let v = ((b[o + 2] as i32) << 24 | (b[o + 1] as i32) << 16 | (b[o] as i32) << 8) >> 8;
                v as f32 / 8_388_608.0
            }
            (1, 32) => i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as f32 / 2_147_483_648.0,
            _ => return Err(format!("{path}: format {format} at {bits} bits is not something this reads")),
        };
        samples.push(v);
    }
    Ok(Wav { samples, rate, channels })
}

// -------------------------------------------------------------- the harness

struct Opts {
    window: usize,
    threshold: f32,
    gap_ms: f64,
    offset_ms: f64,
    low: f64,
    high: f64,
    channel: Option<usize>,
    expect: Vec<f64>,
    at: Vec<usize>,
    flux: bool,
}

impl Default for Opts {
    fn default() -> Self {
        // The config defaults, so a bare run answers "what does the app do
        // right now" rather than "what does some other tuning do".
        Opts {
            window: 1024,
            threshold: 0.4,
            gap_ms: 40.0,
            offset_ms: 0.0,
            low: 30.0,
            high: 16000.0,
            channel: None,
            expect: Vec::new(),
            at: Vec::new(),
            flux: false,
        }
    }
}

fn numbers(text: &str) -> Vec<f64> {
    text.split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect()
}

/// Every onset the app would have reported, in **frames from the start of the
/// file**.
///
/// The trick that makes this exact: the analyzer stamps an onset in beats, so
/// feeding it `beats_per_sample = 1.0` and a hop stamp in frames makes "beats"
/// *be* frames. Nothing is converted and the arithmetic under test is the
/// arithmetic that ships.
fn run(samples: &[f32], channels: usize, rate: f64, o: &Opts) -> (Vec<Onset>, Vec<f32>) {
    let mut analyzer = Analyzer::new(rate);
    let analysed = channels.min(MAX_ANALYSIS_CHANNELS);
    analyzer.configure(analysed, o.window);
    let band = analyzer.band_groups(o.low, o.high);
    let params = OnsetParams {
        threshold: o.threshold,
        min_gap_frames: (o.gap_ms / 1000.0 * rate) as usize,
        offset_frames: o.offset_ms / 1000.0 * rate,
    };

    let mut onsets = Vec::new();
    let mut flux_trace = Vec::new();
    let mut mags = Vec::new();
    let mut frame = vec![0.0f32; analysed];
    let frames = samples.len() / channels.max(1);
    for i in 0..frames {
        for ch in 0..analysed {
            frame[ch] = samples[i * channels + ch];
        }
        if analyzer.push(&frame) {
            // Exactly `main.rs`: the hop that just completed describes the
            // window centred half a window behind this frame.
            let hop_at = i as f64 - analyzer.window_len() as f64 / 2.0;
            analyzer.note_hop_beat(hop_at);
            for ch in 0..analyzer.channels() {
                mags.clear();
                let flux = analyzer.analyze_into(ch, &mut mags, band);
                if ch == o.channel.unwrap_or(0) {
                    flux_trace.push(flux);
                }
                analyzer.pick_onset(ch, flux, 1.0, params, &mut onsets);
            }
            analyzer.advance_hop();
        }
    }
    (onsets, flux_trace)
}

/// Each reported onset against the nearest thing that was actually played.
/// Nearest rather than in order on purpose: a miss or a double should show as
/// one bad row, not throw every row after it out of step.
fn report_errors(found: &[f64], expect: &[f64], rate: f64) {
    if expect.is_empty() {
        return;
    }
    println!();
    println!("  against {} known onsets:", expect.len());
    let mut errors = Vec::new();
    for &f in found {
        let nearest = expect
            .iter()
            .cloned()
            .min_by(|a, b| (a - f).abs().partial_cmp(&(b - f).abs()).unwrap());
        if let Some(e) = nearest {
            let err = f - e;
            errors.push(err);
            println!(
                "    at {:>9.1}  expected {:>9.1}  off by {:>+8.1} frames ({:>+7.2} ms)",
                f,
                e,
                err,
                err / rate * 1000.0
            );
        }
    }
    // Which ones were never reported at all -- the failure a list of errors
    // cannot show, because a missed note contributes no row.
    let missed: Vec<f64> = expect
        .iter()
        .cloned()
        .filter(|e| !found.iter().any(|f| (f - e).abs() < 0.05 * rate))
        .collect();
    if !missed.is_empty() {
        println!("    MISSED (nothing within 50 ms): {missed:?}");
    }
    if errors.is_empty() {
        return;
    }
    errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = errors[errors.len() / 2];
    let mean = errors.iter().sum::<f64>() / errors.len() as f64;
    let spread = errors[errors.len() - 1] - errors[0];
    println!(
        "    median {:+.1} frames ({:+.2} ms), mean {:+.1}, spread {:.1} frames ({:.2} ms)",
        median,
        median / rate * 1000.0,
        mean,
        spread,
        spread / rate * 1000.0
    );
    println!(
        "    a constant bias is `onsetOffset` = {:.2} ms; spread is what no single trim can fix",
        -median / rate * 1000.0
    );
}

fn print_onsets(onsets: &[Onset], rate: f64, channel: Option<usize>) -> Vec<f64> {
    let mut found = Vec::new();
    println!("  {:>9}  {:>9}  {:>7}  {}", "frame", "seconds", "strength", "ch");
    for o in onsets {
        if let Some(c) = channel {
            if o.channel != c {
                continue;
            }
        }
        println!(
            "  {:>9.1}  {:>9.4}  {:>7.3}  {}",
            o.beat,
            o.beat / rate,
            o.strength,
            o.channel
        );
        if channel.map_or(o.channel == 0, |c| o.channel == c) {
            found.push(o.beat);
        }
    }
    found
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: onsets analyze <file.wav> [options]");
        eprintln!("       onsets synth <sample.wav> --at f1,f2,... [options]");
        eprintln!();
        eprintln!("options: --window 1024  --threshold 0.05  --gap-ms 40  --offset-ms 0");
        eprintln!("         --low 30  --high 16000  --channel 0  --expect f1,f2,...  --flux");
        std::process::exit(2);
    }
    let (mode, path) = (args[0].clone(), args[1].clone());

    let mut o = Opts::default();
    let mut i = 2;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).cloned().unwrap_or_default();
        match flag {
            "--window" => o.window = value.parse().unwrap_or(o.window),
            "--threshold" => o.threshold = value.parse().unwrap_or(o.threshold),
            "--gap-ms" => o.gap_ms = value.parse().unwrap_or(o.gap_ms),
            "--offset-ms" => o.offset_ms = value.parse().unwrap_or(o.offset_ms),
            "--low" => o.low = value.parse().unwrap_or(o.low),
            "--high" => o.high = value.parse().unwrap_or(o.high),
            "--channel" => o.channel = value.parse().ok(),
            "--expect" => o.expect = numbers(&value),
            "--at" => o.at = numbers(&value).into_iter().map(|f| f as usize).collect(),
            "--flux" => {
                o.flux = true;
                i += 1;
                continue;
            }
            other => {
                eprintln!("unknown option {other}");
                std::process::exit(2);
            }
        }
        i += 2;
    }

    let wav = match read_wav(&path) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let (samples, channels, label) = match mode.as_str() {
        "analyze" => (wav.samples.clone(), wav.channels, format!("{path}")),
        "synth" => {
            if o.at.is_empty() {
                eprintln!("synth needs --at f1,f2,...");
                std::process::exit(2);
            }
            // A second of room after the last hit, so the picker's lookahead
            // has somewhere to look and the final onset is actually decided.
            let end = o.at.iter().cloned().max().unwrap_or(0) + wav.frames() + wav.rate as usize;
            let mut buf = vec![0.0f32; end];
            for &at in &o.at {
                for f in 0..wav.frames() {
                    if at + f < buf.len() {
                        // Summed to mono: a stereo sample placed on one channel
                        // would measure a different signal than the same sample
                        // placed on both.
                        let mut v = 0.0;
                        for c in 0..wav.channels {
                            v += wav.samples[f * wav.channels + c];
                        }
                        buf[at + f] += v / wav.channels as f32;
                    }
                }
            }
            o.expect = o.at.iter().map(|&f| f as f64).collect();
            (buf, 1, format!("{} placed at {:?}", path, o.at))
        }
        other => {
            eprintln!("unknown mode {other} -- analyze or synth");
            std::process::exit(2);
        }
    };

    let frames = samples.len() / channels.max(1);
    println!(
        "{label}\n  {:.0} Hz, {} channel(s), {} frames ({:.2} s)",
        wav.rate,
        channels,
        frames,
        frames as f64 / wav.rate
    );
    println!(
        "  window {}, hop {}, threshold {}, gap {} ms, offset {} ms, band {}-{} Hz",
        o.window,
        o.window / 4,
        o.threshold,
        o.gap_ms,
        o.offset_ms,
        o.low,
        o.high
    );
    println!();

    let (onsets, flux) = run(&samples, channels, wav.rate, &o);
    let found = print_onsets(&onsets, wav.rate, o.channel);
    println!("  {} onsets", found.len());
    report_errors(&found, &o.expect, wav.rate);

    if o.flux {
        // The detection function itself, for when the question is "why was
        // there no peak there" rather than "where did the peak land".
        println!();
        println!("  flux, one line per hop (frame, value):");
        let hop = o.window / 4;
        for (h, v) in flux.iter().enumerate() {
            println!("    {:>9}  {:.4}", h * hop, v);
        }
    }
}
