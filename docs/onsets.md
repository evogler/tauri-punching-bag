# Onset detection, spectral display and the spectrogram — design notes

Where the thinking got to as of 2026-08-30. Nothing here is built yet except
what's noted under **Status**. A design record, not a spec.

Companion to `docs/patches.md`. The short version: the spectrogram and the good
onset detector are the same computation, so build the picture first and the
detector falls out of it.

## The goal

Two things, from one piece of machinery:

- **Show where onsets are** on the waveform display, as markers, so you can see
  how your attacks sit against the grid without squinting at the envelope.
- **Massage the drawn signal** so attacks are visually obvious even without
  discrete markers. Several options, to be compared by eye rather than argued
  about up front.

And, wanted independently: **a live spectrogram**.

Latency target: within ~100 ms. Instant is not required.

## The latency budget is already spent

`buffer_compensation` is 4330 frames ≈ **98 ms**, and the sample stream is
stamped

```
visual_beat = beat - buffer_compensation * beats_per_sample
```

so the display is already drawing input in the past. A detector that needs
lookahead therefore costs nothing *visually* — it changes when a pixel gets
painted, not where it lands. That is what makes a centred peak-picker (a
smoothing window with future frames in it) affordable, and centred pickers are
meaningfully better than causal ones.

## One FFT, three consumers

**Spectral flux** — the sum of positive frame-to-frame change in magnitude bins
— is the standard general-purpose onset detection function, and the one that
handles the case CLAUDE.md flagged as hard: a new note on one string while
another sustains. The amplitude envelope cannot see that; a magnitude spectrum
can.

It is a subtraction over exactly the magnitudes a spectrogram draws. So:

| Consumer | Cost on top of the FFT |
|---|---|
| Spectrogram | log-bin the magnitudes, quantise to `u8` |
| Onset detection function | one positive-difference sum per hop |
| Onset events | peak-picking over that function |

Building the picture first is also the honest order: the spectrogram is how you
*judge* whether a detector should work on a given instrument, before anyone
tunes a threshold against it.

### Analysis parameters

Window 1024 (23 ms), hop 256 (5.8 ms), Hann. The render callback delivers 2048
frames, so that is exactly 8 hops per callback with no partial-hop bookkeeping
across callbacks. ~172 FFTs/sec/channel — well under a percent of a core.

Frequency resolution is 43 Hz, which is coarse at the bottom; log-binning turns
the lowest bins into mush. A 2048-point window fixes the low end and blurs
transients, which is the wrong trade for the detector. 1024/256 is the standard
onset configuration and is what to start with; if the bass end of the picture is
useless, that is an argument for a second longer-window pass, not for changing
this one.

### Real-time safety

The analysis state lives outside the render closure and is `.resize()`d once per
callback, the same pattern as `tap_gains` and `drum_last_beats`. The FFT planner
is built at startup; `process_with_scratch` does not allocate. **No allocation
per frame** — the rule in CLAUDE.md's Audio thread rules applies unchanged.

If inline analysis ever does show up in the callback's timing, the escape is a
worker thread fed by a tee of the input queues — but `make_buffers` hands out
producer and consumer Arcs of the *same* queue and the render callback drains
them, so a worker needs its own copy of the input rather than a second consumer.
That is a project; don't start there.

## Massaging the signal: analysis as a synthetic channel

The cheap integration. Rather than a new drawing path for "the massaged
waveform", emit it as another synthetic channel, held at full rate into the
existing flattened stream:

```
[ ch 1 … ch N ]  [ drums ]  [ click ]  [ analysis 1 … analysis N ]
```

That inherits rows, margins, grids, row colours, split-channel, visual gain and
per-pane visibility for **zero new drawing code**. Put the flux in its own pane,
or split it against the raw waveform in the same row and watch the spikes line
up with the attacks.

"Which massage" is then a single Rust enum — high-passed, envelope follower,
spectral flux — so building several options to compare costs one dropdown, not
three features. `channelLabels` in `App.tsx` must grow to match, since the
frontend's label order is what defines the bus order.

### The half-window alignment trap

The flux value computed at frame *t* describes the window centred at *t − 512*.
Attach it to frame *t* in the full-rate stream and it draws **11.6 ms late** —
which at `0.25x16` and 140 bpm is about **30 pixels**. Very visible, and it
would read as the detector being wrong rather than the plumbing.

It cannot be fixed by delaying the analysis; delaying makes it later still. The
fix is to delay *everything else*: run the raw channels through a 512-frame
delay line (the `BusDelay` pattern already in `structs.rs`) and stamp the whole
stream with `beat - (buffer_compensation + 512) * beats_per_sample`. Raw and
analysis then describe the same moment, and nothing moves on screen.

**This does not apply to the spectrogram or to discrete onsets**, which carry
their own per-hop beat stamps and can simply be stamped at the window centre.
It is only a problem for values riding in the per-frame stream.

## Onset markers

Discrete events, each stamped with the beat of its window centre (in input time,
i.e. already shifted by the compensation), drawn at every `getCanvasPositions`
location like everything else on the pane.

Peak-picking: normalise the ODF against a moving median over ~100 ms, take local
maxima above a threshold, enforce a minimum inter-onset interval of ~30–50 ms.
Log-magnitude flux rather than linear — better dynamic-range invariance. A
frequency band limit matters more than it sounds: restricting the flux to a band
is how you stop a bass note triggering a snare detector.

Controls wanted in the panel: threshold, minimum gap, band low/high. Likely
per-input-channel eventually — a kick and a guitar want different bands — but
start global and see.

Ordering: markers arrive a few tens of ms after the sweep has passed their
column, so in sweep mode a marker pops in slightly behind the cursor. In
`refreshAtCycleEnd` it is invisible. Not worth holding the stream back over.

**Reset the ODF history on unpause and on beat reset**, or the first hop after
the gap is a phantom onset.

### Honest limits

Pitched, sustaining instruments stay hard. Log-magnitude flux, a band limit, and
SuperFlux's max-filter trick (for vibrato) is roughly the state of the art and
will still miss soft re-articulations on a sustaining string. The spectrogram
will show you why, which is worth having on its own.

## Spectrogram as a view kind

`views[i].kind: "waveform" | "spectrogram"`. That reuses the arrangement grid,
the pane config, `getCanvasPositions` for the x placement and the sweep logic
entirely; only the y axis changes meaning, from amplitude to frequency.

Rows still work, and are the interesting part: set `beatsPerRow` to `4` and each
row is a bar's spectral signature, stacked. You want *few* rows in a spectrogram
pane, since 64 bins need vertical space — but that is a setting, not new
machinery.

- Draw grids over it, same as the waveform. Seeing the grid across a spectrogram
  is most of the point.
- Colour: an intensity ramp in the channel's own colour, so a channel keeps its
  identity across pane kinds. A perceptual map (magma-ish) is the alternative if
  the single-hue ramp reads badly.
- `refreshAtCycleEnd` for spectrogram panes: skip at first. Sweep only.

### Transport

`u8` decibels, not floats. 64 float bins at 172 Hz roughly doubles the JSON;
as bytes it is ~11 KB/s/channel, and 256 brightness levels is all a display can
use. Rust maps magnitude → dB over a fixed wide range (say −100…0 dB) and the
frontend applies its own gain and floor on top, so tweaking the picture never
pushes config across.

This is also where the deferred **decimated sample transport** item starts to
actually matter — the raw stream is still ~44,100 floats/sec/channel of JSON,
and the analysis stream is the first thing that has been *designed* not to be.

### Stream shape

A second stream and a second command (`get_analysis`) rather than overloading
`VisualSamples`, so the per-frame path stays exactly as it is. Flattened the
same way and for the same reason:

```rust
struct AnalysisFrames {
    channels: usize,     // analysed input channels
    bins: usize,
    beats: Vec<f64>,     // one per hop, at the window centre, in input time
    mags: Vec<u8>,       // beats.len() * channels * bins
}
```

Read as `mags[(hop * channels + ch) * bins + bin]`.

## A byproduct worth having

The drum bus's trigger times are known exactly — they are computed in the
callback. Comparing detected input onsets against them is a direct measurement
of whether `buffer_compensation` is tuned right. Onset detection turns into a
latency calibration tool, which is the one thing in this app that has only ever
been done by ear.

## Proposed order

1. **FFT infrastructure + spectrogram pane.** The bulk of the Rust work, and the
   diagnostic for everything after it.
2. **Flux as a synthetic channel.** Nearly free once the FFT exists, and it lets
   the ODF be *looked at* before a threshold is tuned against it. Needs the
   half-window delay line above.
3. **Peak picking → onset markers**, with threshold / min-gap / band controls.
4. **The other massage modes** (high-pass, envelope follower) as alternatives on
   the same bus.

## Status

Step 1 is built: the FFT infrastructure and the spectrogram pane. Steps 2-4 are
not.

Built:

- `src-tauri/src/analysis.rs` -- `Analyzer`, window 1024 / hop 256 / 64 log-ish
  bins, Hann, `realfft`. Planner and scratch built at startup, `resize` once per
  callback, `push` per frame. Analysed channels capped at 4.
- `AnalysisFrames` + `AnalysisOutputBuffer` in `structs.rs`, `get_analysis` in
  `commands.rs`, both mirroring the sample stream. Magnitudes are `u8` over a
  fixed -100..0 dB range.
- Wired into the render callback: pushed per frame next to `input_frame`,
  stamped at the window centre in input time, reset on beat reset and while
  paused.
- `analysis_on` / `analysisOn`, default true, with a checkbox in the visual
  section.
- `views[i].kind` plus `spectrogramChannel` / `spectrogramGain` /
  `spectrogramFloor`, a kind dropdown and the three controls in the panel, and
  `drawSpectrogram` in `App.tsx` -- sweep only, grids clipped to each painted
  column so they sit on top without their alpha saturating.

Not built, and no config keys added for any of it: spectral flux, the ODF, the
synthetic analysis channel and its half-window delay line, peak picking, onset
markers, the other massage modes.

Verified by build, by simulation of the hop timing / beat stamp / flattening
index, and by throwaway Rust tests (a tone lands in its own group, silence
reads 0, hops arrive every 256 frames) that were run and deleted. **Nobody has
looked at the picture yet** -- that it is a sensible spectrogram of real playing,
and that the columns line up with the grid, is unconfirmed.
