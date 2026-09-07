use std::time::Instant;

use crate::constants::sample_rate;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// What the decoder actually found, before anything is done about it. The rate
/// and the channel count used to be dropped on the floor here, which is two
/// silent bugs: a 44.1k file on a 48k device plays 8.8% fast, and a mono file
/// plays an octave high, because the callback advances the read position once
/// per *output* channel and so assumes interleaved stereo.
pub struct AudioFile {
    /// Interleaved, `channels` values per frame, at `rate`.
    pub samples: Vec<f32>,
    pub rate: f64,
    pub channels: usize,
}

impl AudioFile {
    pub fn frames(&self) -> usize {
        if self.channels == 0 {
            0
        } else {
            self.samples.len() / self.channels
        }
    }
}

/// Resample to the device rate and fold to interleaved stereo, so everything
/// downstream can assume both. Linear interpolation, which is coarse but is
/// done *once at load*, off the audio thread -- the alternative is a rate
/// conversion in the render callback, which is exactly what must not happen.
///
/// Mono lands on both sides at full level rather than being panned, since a
/// mono drum bounce is meant to be centred.
pub fn to_device_stereo(file: &AudioFile) -> Vec<f32> {
    let in_ch = file.channels.max(1);
    let in_frames = file.frames();
    if in_frames == 0 {
        return Vec::new();
    }
    // Input frames per output frame. 1.0 when the rates already agree, and the
    // interpolation below then reduces to an exact sample copy.
    let ratio = if file.rate > 0.0 {
        file.rate / sample_rate()
    } else {
        1.0
    };
    let out_frames = ((in_frames as f64) / ratio).floor().max(0.0) as usize;
    let mut out = Vec::with_capacity(out_frames * 2);
    for i in 0..out_frames {
        let src = i as f64 * ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let i1 = (i0 + 1).min(in_frames - 1);
        for side in 0..2 {
            // A mono file reads channel 0 for both sides; anything past stereo
            // is dropped, since the output bus is stereo.
            let c = side.min(in_ch - 1);
            let a = file.samples[i0 * in_ch + c];
            let b = file.samples[i1 * in_ch + c];
            out.push(a + (b - a) * frac);
        }
    }
    out
}

/// Interleaved stereo at the device rate, which is what both the file player
/// and the drum voices assume.
pub fn get_samples_from_filename(filename: &String) -> Result<Vec<f32>, String> {
    Ok(to_device_stereo(&decode_audio_file(filename)?))
}

pub fn decode_audio_file(filename: &String) -> Result<AudioFile, String> {
    let src_result = std::fs::File::open(&filename);
    if let Err(e) = src_result {
        return Err(format!("Failed to open file: {}", e));
    }
    let src = src_result.unwrap();

    // Create the media source stream.
    let mss = MediaSourceStream::new(Box::new(src), Default::default());

    // Create a probe hint using the file's extension. [Optional]
    let mut hint = Hint::new();
    hint.with_extension("mp3");

    // Use the default options for metadata and format readers.
    let meta_opts: MetadataOptions = Default::default();
    let fmt_opts: FormatOptions = Default::default();

    // Probe the media source.
    let probed_result = symphonia::default::get_probe().format(&hint, mss, &fmt_opts, &meta_opts);
    if let Err(_err) = probed_result {
        return Err("unsupported format".to_string());
    }
    let probed = probed_result.unwrap();

    // Get the instantiated format reader.
    let mut format = probed.format;

    // Find the first audio track with a known (decodeable) codec.
    let track_result = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL);
    if let None = track_result {
        return Err("no audio track found".to_string());
    }
    let track = track_result.unwrap();

    // Use the default options for the decoder.
    let dec_opts: DecoderOptions = Default::default();

    // Create a decoder for the track.
    let decoder_result = symphonia::default::get_codecs().make(&track.codec_params, &dec_opts);
    if let Err(_err) = decoder_result {
        return Err("unsupported codec".to_string());
    }
    let mut decoder = decoder_result.unwrap();

    // Store the track identifier, it will be used to filter packets.
    let track_id = track.id;

    // The container header usually carries both, but the spec on a decoded
    // packet is authoritative, so it overwrites these below.
    let mut rate = track.codec_params.sample_rate.unwrap_or(0) as f64;
    let mut channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(0);

    let mut sample_data: Vec<f32> = Vec::new();

    // The decode loop.
    loop {
        // Get the next packet from the media format.
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::ResetRequired) => {
                // The track list has been changed. Re-examine it and create a new set of decoders,
                // then restart the decode loop. This is an advanced feature and it is not
                // unreasonable to consider this "the end." As of v0.5.0, the only usage of this is
                // for chained OGG physical streams.
                unimplemented!();
            }
            Err(err) => {
                if err.to_string() == "end of stream" {
                    return Ok(AudioFile {
                        samples: sample_data,
                        rate,
                        channels,
                    });
                } else {
                    println!(
                        "there was an error while reading an audio file: {:?}",
                        err.to_string()
                    );
                    return Err(err.to_string());
                }
            }
        };

        // Consume any new metadata that has been read since the last packet.
        while !format.metadata().is_latest() {
            // Pop the old head of the metadata queue.
            format.metadata().pop();

            // Consume the new metadata at the head of the metadata queue.
        }

        // If the packet does not belong to the selected track, skip over it.
        if packet.track_id() != track_id {
            continue;
        }

        // Decode the packet into audio samples.
        match decoder.decode(&packet) {
            Ok(_decoded) => {
                // Consume the decoded audio samples (see below).
                if _decoded.frames() > 0 {
                    let spec = *_decoded.spec();
                    rate = spec.rate as f64;
                    channels = spec.channels.count();
                    let mut samples: SampleBuffer<f32> =
                        SampleBuffer::new(_decoded.frames() as u64, spec);
                    samples.copy_interleaved_ref(_decoded);

                    let new_sample_data: Vec<f32> = samples.samples().iter().map(|s| *s).collect();
                    for i in 0..new_sample_data.len() {
                        sample_data.push(new_sample_data[i]);
                    }
                    // println!("{:?}", sample_data);
                }
            }
            Err(Error::IoError(_)) => {
                // The packet failed to decode due to an IO error, skip the packet.
                continue;
            }
            Err(Error::DecodeError(_)) => {
                // The packet failed to decode due to invalid data, skip the packet.
                continue;
            }
            Err(err) => {
                // An unrecoverable error occured, halt decoding.
                panic!("{}", err);
            }
        }
    }
}
