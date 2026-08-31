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

**The window is a setting** (`analysisWindow`, one of 256/512/1024/2048/4096,
default 1024), because frequency resolution and time resolution trade directly
and which side you want depends on what you are looking at. The hop is always a
quarter of it: one control moves the smear, the spectrogram's column width and
the flux's precision together, and the overlap stays at the conventional 4x.
Decoupling them would add a knob whose wrong settings blur the flux rather than
sharpen it.

The cost of a shorter window is the low end, in the exact way the bin edges
already suffer: wherever log spacing asks for finer than the window's
resolution the axis goes one FFT bin per group -- linear, not log -- and a
shorter window pushes more of the axis into that regime.

What follows describes the default.

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

## Massaging the signal: not a synthetic channel

The cheap-looking integration, and the one this document originally proposed,
was to emit the massaged signal as another synthetic channel held at full rate
in the existing flattened stream:

```
[ ch 1 … ch N ]  [ drums ]  [ click ]  [ analysis 1 … analysis N ]
```

That inherits rows, margins, grids, row colours, split-channel, visual gain and
per-pane visibility for zero new drawing code. **It was not built that way**,
because of the trap below: the flux describes a window centred half a window
back, and a per-frame stream can only carry a value stamped *now*.

**What was built instead: the flux rides in `AnalysisFrames`, next to `mags`.**
That stream already carries one beat stamp per hop, at the window centre, in
input time — the alignment problem is already solved there and already verified.
The sample stream, `buffer_compensation` and `BusDelay` are untouched. The price
is a small amount of new drawing code in `App.tsx` (`drawFlux`, `collectFlux`,
`drawFluxAt`), which reuses `drawChannel`, so rows, margins, `isMargin` dimming,
split-channel and channel colours still come for free.

"Which massage" can still be a Rust enum later; those modes just don't need a
bus.

### The half-window alignment trap — why the synthetic channel was dropped

The flux value computed at frame *t* describes the window centred at *t − 512*.
Attach it to frame *t* in the full-rate stream and it draws **11.6 ms late** —
which at `0.25x16` and 140 bpm is about **30 pixels**. Very visible, and it
would read as the detector being wrong rather than the plumbing.

It cannot be fixed by delaying the analysis; delaying makes it later still. The
only fix inside the per-frame stream is to delay *everything else*: run the raw
channels through a 512-frame delay line (the `BusDelay` pattern in `structs.rs`)
and stamp the whole stream with `beat - (buffer_compensation + 512) *
beats_per_sample`. That works, and it is a lot: a delay line on every channel, a
global shift of the display, and a second thing that has to stay in step with
`buffer_compensation` forever — all to avoid writing one draw pass.

**This never applied to the spectrogram, to the flux as shipped, or to discrete
onsets**, all of which carry their own per-hop beat stamps and are simply
stamped at the window centre. It is only a problem for values riding in the
per-frame stream, which is why nothing rides there.

It also does not apply to the *sample-rate* massage modes (high-pass, envelope
follower). A filtered sample is aligned with the sample it came from, so those
can go in the per-frame stream — as another synthetic channel, or as a mode
switch on an existing one — with no delay line at all. Only the FFT-derived
values are half a window behind.

## Onset markers

Discrete events, each stamped with the beat of its window centre (in input time,
i.e. already shifted by the compensation), drawn at every `getCanvasPositions`
location like everything else on the pane.

Peak-picking: normalise the ODF against a moving median over ~100 ms, take local
maxima above a threshold, enforce a minimum inter-onset interval of ~30–50 ms.
The ODF itself is log-magnitude and band-limited already — both were built in
step 2, for the same reasons: dynamic-range invariance, and stopping a bass note
from triggering a snare detector.

Controls still wanted in the panel: threshold and minimum gap. The band pair is
global and already there. Per-input-channel bands eventually — a kick and a
guitar want different ones — but global first, and see.

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
2. **Flux on the analysis stream.** Nearly free once the FFT exists, and it lets
   the ODF be *looked at* before a threshold is tuned against it. No delay line:
   see the section above for why it does not go in the per-frame stream.
3. **Peak picking → onset markers**, with threshold / min-gap controls (the band
   controls exist already, since the flux needs them).
4. **The other massage modes** (high-pass, envelope follower). Sample-rate, so
   they *can* be synthetic channels in the per-frame stream, and they need no
   delay line either — a filtered sample sits on the frame it came from.

## Status

Steps 1, 2 and 3 are built. Step 4 is not.

- **Step 1 -- FFT and spectrogram.** `src-tauri/src/analysis.rs`, `AnalysisFrames`
  + `get_analysis`, `views[i].kind = "spectrogram"` with channel/gain/floor.
  The window is a setting (256..4096, default 1024) with the hop always a
  quarter of it; every size is planned and every buffer sized at the maximum at
  startup, so changing it reallocates nothing.
- **Step 2 -- spectral flux.** Log-domain, band-limited
  (`analysisBandLow`/`High`), normalised per bin in the band so narrowing the
  band doesn't rescale it. Rides on the analysis stream, *not* as a synthetic
  channel -- see the section above for why that avoided the delay line
  entirely. Per-view `showFlux` / `fluxGain`.
- **Step 3 -- peak picking and onset markers.** `Analyzer::pick_onset`, sparse
  `Onset { beat, channel, strength }` on the same stream, per-view `showOnsets`,
  and `onsetThreshold` / `onsetMinGap` / `onsetOffset`. Spans are in
  milliseconds so they track the window. Sub-hop placement by parabolic
  interpolation, and a measured window-proportional correction for the flux
  peaking as a transient *enters* the window rather than at its centre.
- **Step 4 -- the other massage modes** (high-pass, envelope follower) is not
  started. It needs no delay line either: a filtered sample is aligned with the
  sample it came from.

Measured, in throwaway tests that were run and deleted:

- Silence gives no onsets; a tone that starts once gives exactly one; a click
  gives exactly one at every window size.
- Reported times land within **half a hop** of the true attack at every window
  (0.64/1.20/1.97/4.43/8.68 ms for 256..4096) once the centre bias is corrected.
- The minimum gap suppresses a second click 20 ms later and lets it through at a
  10 ms setting; the threshold gates a quiet click both ways; reset clears the
  picker.
- Flux: a tone entering reads 2.31, twenty hops of sustain under 0.009, a decay
  under 0.01, an excluded band exactly 0.
- The 1024 bin edges are identical to the pre-parameterisation formula, and a
  window change moves no allocation (pointer identity).
- All 27 `Config` fields match between `defaultRustConfig` and the Rust struct,
  which is what stops `set_config` failing on a serde error.

**Nobody has looked at any of it against real playing.** That the spectrogram is
legible, that the flux spikes on attacks and not between them, that the markers
land where the eye expects against the grid, and that the default threshold and
gap are anywhere near right for a real instrument, are all unconfirmed. The
0.32 centre-bias constant in particular was measured on a synthetic instant
attack; `onsetOffset` exists because a real instrument will differ.
