# Making the app approachable

A plan for getting this ready to hand to friends without giving up any of what
makes it powerful. Nothing here removes a feature, a setting or the text
inputs. The goal is that a newcomer can get to "playing against a grid" without
understanding the rest, and can find the rest when they want it.

Written 2026-09-13. Nothing in it is built yet.

## Principles

- **Reveal things as they become relevant, not through modes.** No beginner or
  advanced switch. Modes split the app in two: every screenshot and every
  explanation has to say which mode it's in, and friends outgrow them at
  different rates. Instead: good defaults, controls hidden until the switch
  they depend on is on, and a "more" expander on the few sections with expert
  knobs.
- **The text stays the source of truth.** Anything added to an input (dragging,
  previews, readouts) is a view of the text or a way of writing it, never a
  replacement for it.
- **Teach with examples, not a tour.** People skip tours. An example that
  sounds like something, with one sentence saying what to try, teaches better.
- **Structure before style.** Restyling a panel that's about to be rearranged
  means styling it twice.
- **Rename labels freely, never config keys.** Labels are display text.
  Renaming a key is the `loopFeedback` trap (see CLAUDE.md), and saved sessions
  and presets depend on the keys.

## Phase 0: watch someone use it

Before building anything, sit one friend down with the current build on their
own machine. Don't help. Write down every place they stop, hesitate, or ask a
question, and what they expected to happen.

- Give them a goal rather than a list of features: "get a click going and play
  16ths against it", then "loop what you played".
- Note whether they get the microphone prompt and the latency right *without
  help*. This is the most likely place for a friend to quietly give up.
- Re-rank the phases below by what actually happened. The order here is a
  guess made by the two people least able to judge it.

## Phase 1: first-launch setup and built-in examples

The biggest win for the least work. It gets a newcomer to a correct, working
state before they touch the panel.

### First-launch setup

A short sequence shown once, and again from a "run setup again" button in the
Setup tab.

1. **Microphone.** Say why the app needs it before macOS asks. If input stays
   silent afterwards, say so plainly and point at System Settings → Privacy &
   Security → Microphone. Silence with no explanation is the failure that cost
   a day on 2026-09-06.
2. **Input and output device.** The existing `DevicePicker`, with a sentence
   saying that changing a device restarts the app.
3. **Headphones or speakers?** Speakers leads straight into **measure bleed**
   and turns `bleedCancelOn` on if the measurement passes. Headphones skips it.
4. **Measure latency.** The existing `Calibration`, explained in one sentence:
   *"so what you play is drawn where you played it."* Offer to apply the
   result. This step matters most: with the wrong latency, playing is drawn in
   the wrong place and a friend concludes they're sloppy or the app is broken.
5. **Pick a starting point.** The example picker below.

Notes:

- Whether setup has been done is **not a config key.** Store it under its own
  localStorage key, or in `audio-prefs.json` alongside the device choice, since
  it describes the install rather than the music. Keep it out of presets and
  the session.
- Every step can be skipped. Nothing gets locked behind it.
- Latency and bleed already refuse a result they can't stand behind and show
  their numbers. The setup keeps that, and adds one line saying what to do when
  a step fails ("too quiet: turn the speaker up or move closer").

### Built-in examples

Read-only presets bundled with the app, each one teaching one idea, each with a
title, a one-line description and a "try this" line.

| Example | Teaches | Try this |
|---|---|---|
| Just a metronome | tempo, click, pause | change the bpm |
| 16ths against the grid | rows, grids, what the picture means | play on the lines |
| 3 against 4 | two panes, different rulings | watch one phrase against both |
| Count-off, then groove | the practice cycle | change the order |
| Loop yourself | looper, echoes | play a phrase, then play over it |
| Play along with a song | file player, file beats, a–b repeat | choose a file |
| Random tempo drill | parameters, `range`, ⌘R | reroll between passes |
| Speakers, not headphones | speaker bleed | measure, then play |

Implementation notes:

- **They load through `loadPreset`**, so they get the existing guarantees for
  free: merged over the defaults, and `bufferCompensation` carried across so an
  example never overwrites a measured latency.
- **Kept separately from user presets.** Bundled as a TS module rather than
  seeded into localStorage, so an update can improve them and a user can't
  delete them by accident. "Save as…" from an example makes an ordinary user
  preset.
- **Built from real config by saving from the running app**, not written by
  hand. A hand-written preset is the `audioSubdivisions` problem in CLAUDE.md
  (a `val` that isn't what its `inputText` parses to). A temp test that
  re-parses every example's rhythm and expression text and compares it with the
  stored `val` guards against drift.
- The "try this" line is displayed next to the preset bar while that example is
  loaded, and disappears once anything has been changed, or on dismiss.
- Examples that need a file (play along with a song) can't ship one. They say
  "choose a file" instead of failing silently. Don't bundle audio unless a
  licence-free loop turns up.

## Phase 2: reorganise, rename, add the help panel

### New tabs, organised by task

| Tab | Holds |
|---|---|
| **Play** | tempo, click, drums, practice cycle, file |
| **Loop** | looper (on, beats, echoes, echo gain), audio monitor |
| **See** | arrangement, chain panes, per-pane settings (channels, kind, rows, margins, gain, split, colours, grids, overlays), background and pane gap |
| **Setup** | devices, latency (measure *and* the raw value together), speaker bleed, input gain, input channels (colour, pan, trim), updates, run setup again |
| **Analysis** | high pass, spectrum analysis on/off, FFT window, flux band, onset threshold / gap / offset, frame time |

Moves worth calling out:

- **Latency becomes one section.** Today the measure button is under *device*
  and `bufferCompensation` has a separate section further down.
- **Frame time goes into Analysis**, at the bottom. It's a diagnostic.
- **High pass moves to Analysis.** It exists mainly to make note starts easier
  to see, and "filter the sound too" is the kind of expert knob that tab is for.
- **Parameters stop being the first thing on screen.** Keep them reachable from
  every tab (the reason they were pinned still holds), as a strip that starts
  collapsed and shows a count ("parameters · 3"). It opens automatically when a
  field references a parameter that doesn't exist.
- **The preset bar and example picker stay pinned** with the transport.
- The open tab stays plain React state, per the existing rule. Renaming a tab
  changes nothing saved.

### Label pass

One vocabulary everywhere. Some candidates:

| Now | Proposed |
|---|---|
| `beatsToLoop` | loop length (beats) |
| `bufferCompensation` | latency (frames), with ms shown beside it |
| RESET TIME | restart from beat 1 |
| visual monitor / audio monitor | show input / hear input |
| refresh at cycle end | draw: sweep / whole pass |
| bar color mode | colour by loudness |
| flux / show flux | attack strength |
| fft window | analysis window |
| click offset (beats), file shift (beats) | shift (beats) |
| file offset (ms), drum offset | attack offset (ms) |

- **Pick one word each for "shift" and "offset"** and use them for the click,
  the drums, the file and the grids. "Shift" means musical placement in beats;
  "offset" means aligning a sample's attack in ms. That split already exists in
  the code and only needs to show up consistently in the labels.
- **Consistent casing.** Everything lowercase to match the rest, or sentence
  case throughout, but not both.
- **Rewrite the error banner** in the user's terms: "A setting couldn't be
  applied, so the sound doesn't match what the panel shows. Fix the field
  outlined in red." Keep the technical detail underneath, smaller.

### The help panel

A fixed area at the bottom of the panel that describes whatever control is
under the mouse, or has focus, like Ableton's Info View.

- **Everything gets a `help` string.** `Input`, `Slider`, `ColorInput` and the
  list components gain a `help` prop that replaces `title`. It sets the help
  panel's text on `mouseenter` / `focus` through a small context.
- **Help strings live in one module** (`src/help.ts`), keyed by config key
  where there is one. That keeps the description pass reviewable in one place,
  and makes it the natural source for any written docs later.
- **What each entry says:** what it does, *why you'd change it*, its units, and
  a syntax example where it takes one. Two to four lines. Example:
  > **shift (beats)**. Moves this part later by this many beats. `0.5` puts
  > a click on the offbeat. Musical placement: it follows the tempo.
- **Expression fields also show their resolved value** in the help panel
  (`bar/n x n` → `0.25 × 16`), so the panel doubles as a readout.
- **When nothing is hovered** it shows a rotating tip, or the loaded example's
  "try this" line.
- **Say what's clickable:** "click a pane to hide this panel" appears there when
  the mouse is over a pane.
- Keep `title` only where the help panel can't reach (over the canvas when the
  panel is hidden).

## Phase 3: make the text fields friendlier

### Drag to change numbers

- Dragging horizontally on a numeric field's **label** changes the value; typing
  still works exactly as now. Shift for fine steps, ⌥ for coarse.
- **Only for literal text.** If the field holds an expression (`bar/n`), dragging
  does nothing. The help panel shows what it works out to, and a click on the
  label selects the text instead. Dragging must never overwrite an expression.
- Step size from the field: whole numbers for bpm, 0.01 for gains, 1 for ms and
  frames. Store it next to the help string.
- Writes go through the same commit path as typing, including validators, so a
  drag can't push a value that typing couldn't.
- jsdom has no `PointerEvent`: stub it in the temp test (see Conventions).

### Rhythm preview

- Under every rhythm field (click, drums, grids), draw a small strip showing
  one cycle, with a tick at each note time and a dimmer tick on each whole
  beat.
- **Drawn from the parsed `val`**, so it shows the last rhythm that worked while
  the field is red. That makes a mistake readable: the text is wrong, the
  preview is what's still playing.
- Parser2's `{notes, start, end}` already has everything needed. It's pure
  drawing, with no new parsing.
- Taller variant for drum voices showing per-hit `gains` as tick height, so
  `1, 0.5x3` is visible as an accent pattern.

### Syntax examples on demand

- A "?" beside rhythm and list fields opens a short card of examples you can
  click to insert (`2:1`, `[k 1, h 1]x4:1`, `1, 0.5x3`). The syntax table in
  CLAUDE.md is the source.

## Phase 4: visual polish

After the structure has settled.

- One type scale (panel labels, section headers, help text, hints) and one
  spacing unit.
- Section headers that look like headers. `Divider` stays as the sub-group
  hairline.
- A calmer palette: one accent colour for "on", one warning colour, and no
  ad-hoc `#e86` / `#aaa` / `#c44` scattered through `App.tsx`. Pull them into a
  small tokens module.
- Consistent controls: every on/off switch looks the same, every "measure"
  action is the same kind of button, every result readout has the same
  pass/fail styling.
- The transport should read as the transport: bigger, with the tempo visible
  beside it.
- An app icon and a window title that aren't the defaults, if they still are.
- Leave the canvas alone apart from the empty state: before any input arrives,
  a quiet centred line ("waiting for input — check Setup if this stays empty").

## Phase 5: documentation, only for the gaps

Once the help panel exists, the reference half of the docs is already written.
What remains:

- **A one-page "what is this"** for the release notes / GitHub README: what
  the app is for, a screenshot, how to install, first steps.
- **Short screen recordings** for the things that are hard to describe in text:
  playing against two panes at once, the practice cycle, the looper.
- Written only for questions Phase 0 (and later friends) actually raised.

## Risks and rules to keep

- **Examples and setup must not touch `bufferCompensation`** except through the
  explicit latency step. `loadPreset` already guarantees this for presets. Keep
  that guarantee for anything new that loads config.
- **No new config key reused with new meaning.** If a control's behaviour
  changes as part of this, it gets a new key.
- **Hidden tabs stay mounted** (`TabPanel` uses `display: none`), or the
  reorganisation throws away half-typed fields.
- **Don't add `react-hooks` eslint-disable comments** while restructuring
  `App.tsx`. They are build errors here.
- **`App.tsx` is 2,700 lines** and Phase 2 moves most of its panel JSX around.
  Split each tab into its own component file as part of that move rather than
  rearranging in place. It makes the diff reviewable and the tabs easier to
  change afterwards.
- **`yarn tauri build` after every change**, as always.

## Open questions

- Should examples live in the preset dropdown (marked as examples) or in a
  separate picker? Separate is clearer for newcomers; one dropdown is less UI.
- Does the first-launch setup restart the app when the device changes, or defer
  that until the end of setup?
- Lowercase labels are part of the app's current voice. Keep that, or move to
  sentence case during the label pass?
- How much of the rhythm syntax should a newcomer ever need to see? Is there a
  small "pattern builder" (click cells to toggle hits) worth having that
  *writes* rhythm text, without replacing it?
- Is the random tempo drill a beginner example, or does it belong with the
  advanced ones?
