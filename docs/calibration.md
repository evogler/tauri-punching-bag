# Latency calibration

How `measure latency` in the device section works, and why it is built this way.
The short version lives in `src-tauri/src/calibration.rs`; this is the long one.

## What is being measured

`buffer_compensation` exists because the input you capture is older than the
beat the callback is on. The display stamps captured samples
`visual_beat = beat - buffer_compensation * beats_per_sample` so that what you
played is drawn where you played it, and `BusDelay` holds the synthesised drums
and click back by the same amount so they meet it.

The number that makes that correct is the **round trip**:

```
  frame F          the callback writes a sound to the output buffer
  F + L_out        it reaches your ears
  F + L_out        you play in time with what you hear
  F + L_out + L_in the input callback hands those frames back
```

So `buffer_compensation = L_out + L_in`. Both halves are in it — which is why
the stored value is keyed by the **device pair**, not the input device alone.
Swapping headphones for the interface's own output changes `L_out` and changes
the answer.

Both indices come from the same counter — the render callback's own frame
position — so nothing has to be converted between clocks. The measurement is a
subtraction.

## The probe: a swept sine, not a click

A 20 ms Hann-windowed linear sweep from 500 Hz to 8 kHz.

An impulse is the obvious probe and the wrong one. Its energy is spread evenly
across the spectrum, so most of it lands where a small speaker cannot reproduce
it and a microphone does not hear well. What comes back has no low end and a
peak several milliseconds wide.

A sweep fixes both problems at once:

- **Energy where the hardware works.** 500 Hz–8 kHz is the band a speaker and a
  microphone are both efficient in, so the returning signal is far stronger for
  the same peak level — which means the probe can be quiet enough not to be
  unpleasant and still measure well.
- **Pulse compression.** Correlating a sweep against itself concentrates its
  whole duration into a peak roughly `1 / bandwidth` wide. Here that is
  `1 / 7500 Hz` ≈ 133 µs, about **six frames** — much sharper than the 20 ms
  the signal actually occupies. The time-bandwidth product (0.02 s × 7.5 kHz
  ≈ 150) is the processing gain: that is how a quiet probe beats a noisy room.

The Hann window matters for a small reason: without it the sweep starts and
ends on a step, and those two clicks are broadband transients sitting either
side of the thing being measured.

## The detector: a matched filter

Cross-correlate the **known chirp** against the captured input, over lags from
0 to 500 ms:

```
corr[lag] = | Σ chirp[j] · capture[start + lag + j] |
```

This is the part that answers "but the sound comes back transformed". The
speaker's response, the room, and the microphone all **convolve** with the
probe. Convolution does not move where the signal *starts* — it smears what
arrives after. So the correlation peak still marks the arrival, and coloration
costs sharpness rather than accuracy. We are not pattern-matching a waveform;
we are locating a known signal, and that survives filtering.

Three details:

- **No FFT.** Because the chirp is generated here, its samples are known, so
  there is nothing to record on the output side — only the frame index the probe
  started at. An 882-sample template across a 500 ms search window is ~20M
  multiply-adds per probe; five probes run in well under a second on a normal
  thread. An FFT-based correlation would be faster and is not needed.
- **First peak, then its apex.** In a live room an early reflection can be
  *louder* than the direct arrival, and it is the direct arrival that answers
  "how long did this take". So take the first lag reaching 50% of the maximum,
  then climb to the top of that same peak — the crossing finds the leading edge,
  which sits a few frames early.
- **Five probes, median.** A door closing during one of them shifts that
  estimate. The median outvotes it; the spread across the five is reported as a
  confidence measure in its own right.

### Why not the onset detector

`Analyzer::pick_onset` already exists, already peak-picks, and already does
sub-hop interpolation. It is the wrong tool here for two reasons. Its resolution
is a hop — 5.8 ms at the default window, against ~0.1 ms for the matched filter.
And it carries `ONSET_CENTRE_BIAS` and `onsetOffset`, two corrections that were
themselves calibrated by ear against the drums bus. Measuring latency with an
instrument whose own zero point is one of the things you are trying to establish
is circular. The onset detector is for the display; the matched filter is the
ruler.

## Refusing to answer

More important than the measurement. A calibration that is confidently wrong is
worse than none, because you stop suspecting it. Four gates, reported in the
order you can act on them:

| Gate | Threshold | Means |
|---|---|---|
| Input level | peak > −45 dB | Nothing came back. Output louder, or microphone closer. |
| Match strength | peak > 8× the median correlation | Loud, but the filter found noise, not the probe. |
| Probes found | at least 3 of 5 | Intermittent — something is marginal. |
| Agreement | spread < 5 ms | Probes disagree; something moved, or the room is very live. |

All four numbers are shown **whether it passes or fails**, with their thresholds,
because "too quiet" and "loud but not locking" want opposite responses from the
user and a bare failure message cannot distinguish them.

The result is never applied on its own — it is offered with an `apply` button.

## Accuracy

Checked against a simulated round trip (one-pole low pass for speaker and
microphone rolloff, an added reflection, broadband noise) at delays of 2200,
3000 and 4330 frames. Recovered within **4–5 frames**, about 0.1 ms, in every
case including one where the reflection was 40% louder than the direct arrival
and one at a 25 dB worse signal-to-noise ratio. Silence and loud uncorrelated
noise were both refused rather than answered.

Those tests were temporary and deleted, per the repo convention.

Then verified against real hardware on 2026-09-06, which is the check that
matters:

- It measured **4331-4333 frames** where `buffer_compensation` had been tuned
  **by ear** to 4330. Two independent methods, neither able to influence the
  other, agreeing to within 0.07 ms.
- Moving the microphone a few feet back added **~100 frames**. That is 2.27 ms,
  and sound covers about 1.125 ft/ms, so ~2.5 feet — the distance it was moved.

The second is the stronger result. Agreement with a hand-tuned number could in
principle be luck; a measurement that tracks the microphone's position is
reading the acoustic path itself.

## What it does to the audio thread

Nothing that breaks the existing rules. Calibration is an early-return branch in
the render callback, next to the `paused` one:

- The run is allocated **in `start_calibration`**, off the audio thread. The
  callback only indexes into it.
- The state is locked **once per callback**, like the display buffers — never
  per frame.
- The capture is handed over by `mem::take`, not copied, so the audio thread
  never waits on a memcpy of a second of audio. Same rule as `DrainSizes`.
- The correlation runs in the command, outside the lock.

It takes the callback over completely — no drums, looper, monitor or file —
because it is measuring how long the app's own sound takes to return, and
anything else playing would correlate against the probe. Every input channel is
still drained even though only one is measured: `make_buffers` hands out the
same queue to both ends, so an undrained channel grows without bound and then
replays the backlog.

## Using it

Put the microphone against a speaker, or **inside a headphone cup with the
volume up**, which works well and is the only way to measure a headphone
monitoring path — you cannot record headphones from across the room, and the
`L_out` of headphones is not the `L_out` of speakers.

A loopback cable from an interface's output to its input is the most accurate
option: no air path, no room.

The measurement includes the air path at roughly 1 ms per foot, so keeping the
microphone close keeps that under a millisecond. It is not corrected for,
because the app has no way to know the distance.
