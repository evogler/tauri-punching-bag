# Making the app approachable

A plan for getting this ready to hand to friends without giving up any of what
makes it powerful. Nothing here removes a feature, a setting or the text
inputs. The goal is that a newcomer can get to "playing against a grid" without
understanding the rest, and can find the rest when they want it.

Written 2026-09-13. Nothing in it is built yet, with one exception noted
below: **one row per note** (CLAUDE.md has the section) was built on the day
this was written, because it is the setting the owner actually practises with
and it needed no restructuring to add.

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

**Setup built 2026-09-14** (`src/SetupWizard.tsx`; CLAUDE.md has the details).
The relaunch question resolved itself: progress is saved on every step, so any
restart -- the wizard's or the device picker's -- comes back to the step it
left. The "pick a starting point" step waits for the examples, which wait for a
built-in drum kit. Setup shows only on a fresh install; an existing install
gets it from the Setup tab.

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

**Started 2026-09-19**: the picker, the store and the authoring script are
built, with the first two examples in. The rest of this table is the queue --
each one is now an afternoon in the app rather than a piece of code. See
*Built-in examples* in CLAUDE.md for the mechanism.

| Example | Teaches | Try this |
|---|---|---|
| Just a metronome | tempo, click, pause | change the bpm |
| 16ths against the grid | rows, grids, what the picture means | play on the lines |
| 3 against 4 | two panes, different rulings | watch one phrase against both |
| Count-off, then groove | the practice cycle | change the order |
| Loop yourself | looper, echoes | play a phrase, then play over it |
| Play along with a song | file player, file beats, a–b repeat | choose a file |
| Speakers, not headphones | speaker bleed | measure, then play |

Advanced, listed after a divider in the picker:

| Example | Teaches | Try this |
|---|---|---|
| Random tempo drill | parameters, `range`, ⌘R | reroll between passes |

Implementation notes:

- **They load through `loadPreset`**, so they get the existing guarantees for
  free: merged over the defaults, and `bufferCompensation` carried across so an
  example never overwrites a measured latency.
- **A separate picker from saved presets** (decided 2026-09-13). Bundled as a
  TS module rather than seeded into localStorage, so an update can improve them
  and a user can't delete them by accident. Saving after loading an example
  makes an ordinary user preset.
- **Built from real config by saving from the running app**, not written by
  hand. A hand-written preset is the `audioSubdivisions` problem in CLAUDE.md
  (a `val` that isn't what its `inputText` parses to). A temp test that
  re-parses every example's rhythm and expression text and compares it with the
  stored `val` guards against drift. `yarn example:add <exported.json>` is that
  flow: save it in the app, export it from *Manage…*, run the script, write the
  description.
- The "try this" line is displayed next to the preset bar while that example is
  loaded, and disappears once anything has been changed, or on dismiss.
- Examples that need a file (play along with a song) can't ship one. They say
  "choose a file" instead of failing silently. Don't bundle audio unless a
  licence-free loop turns up.

## Phase 2: reorganise, rename, add the help panel

### Order of work

1. **Split the panel out of `App.tsx`, with no visible change.** One component
   file per current tab (`panel/SoundTab.tsx` etc.), plus the pinned header.
   Props are the `get`/`set`/`params`/`viewIO` bundle they already close over.
   Build, and check in the app that nothing moved. Every later step is then a
   small diff in one file rather than a move inside 2,700 lines.
2. **Rearrange** into the tabs below. Controls move; labels stay as they are, so
   a missing or duplicated control is easy to spot.
3. **Relabel** from the tables below. Text only.
4. **Help panel**, then the description pass that fills `src/help.ts`.

Build after each step, as always.

### Vocabulary

Words used the same way everywhere. The help text defines each one once.

| Word | Means | Replaces |
|---|---|---|
| **Shift (beats)** | musical placement: moves a part later by beats, follows the tempo | "click offset (beats)", "file shift", the grid offset |
| **Offset (ms)** | mechanical alignment: starts a sound early so its attack lands on the beat | "file offset (ms)", the drums' ms column |
| **Pane** | one drawing area | "view" |
| **Preset** | saved settings | "config" |
| **Lead-in / lead-out** | beats drawn before and after a row | "left / right margin" |
| **Live input** | what is coming in the microphone right now, as opposed to loop echoes | "monitor" |
| **Attack strength** | the spectral flux curve | "flux" |
| **Note starts** | detected onsets | "onsets" |

Where a control shows both Shift and Offset, **Shift comes first.**

### The arrangement, exactly

Sentence case throughout. Tables list controls top to bottom. "Key" is the
config key, which does not change; `—` means a button or display with no key.
Anything marked **moved** comes from a different tab than today.

#### Pinned above the tabs

| Section | Control | Now | New label | Key |
|---|---|---|---|---|
| (transport) | pause button | ⏸ PAUSE / ▶ RESUME | ⏸ Pause / ▶ Resume | `paused` |
| | reset button | RESET TIME | Restart from beat 1 | — |
| | tempo field, **moved** from sound › bpm | bpm | Tempo (bpm) | `bpm` |
| | looper switch, **moved** from signal › looping | looping (⌘L) | Looper (⌘L) | `loopingOn` |
| (error banner) | | "the audio thread refused this config…" | **A setting couldn't be applied, so what's playing doesn't match the panel.** Fix the field outlined in red. *(technical detail below, smaller)* | — |
| Examples | section, **built 2026-09-19** | | Examples | — |
| | dropdown empty state | | Choose an example… | — |
| | try-this line, until anything changes | | **Try this:** … ✕ | — |
| Presets | section | configs | Presets | — |
| | dropdown empty state | -- pick a config -- / -- no saved configs -- | Choose a preset… / No saved presets | — |
| | buttons | LOAD · DELETE · SAVE · DEFAULTS | Load · Delete · Save · Reset to defaults | — |
| | hint | Name the current settings and hit SAVE. | Name your current settings and click Save. | — |
| Parameters | section, collapsed by default, shows count | parameters | Parameters (3) | `parameters` |
| | reroll all | 🎲 | Reroll all (⌘R) | — |

The section rail reads **Play · File · Loop · Display · Layout · Setup ·
Analysis** (was sound · signal · visual · views). Revised 2026-09-13 after
seeing the first rearrangement: the file and the layout chrome got tabs of
their own, "See" became "Display", and presets collapse like parameters.

**A column down the right-hand edge rather than a row of tabs, 2026-09-19.**
A row divides one panel width between however many sections there are -- at
seven each tab was already 85px and the next few would have truncated their own
labels, so the layout got worse exactly as the app grew. The column is grouped
under *sound*, *picture* and *machine*, stays put while the settings beside it
scroll, and each entry has a help entry of its own.

#### Play

| Section | Now | New label | Key |
|---|---|---|---|
| **Click** | click | Click | `clickOn` |
| | click rhythm | Rhythm | `audioSubdivisions` |
| | click volume | Volume | `clickVolume` |
| | click offset (beats) | Shift (beats) | `clickShift` |
| **Drums** | drums on | Drums | `drumOn` |
| | columns: sound · rhythm · gain · beats · ms · vol | Sound · Rhythm · Accents · Shift · Offset · Volume | `drums[]` |
| | add button | Add sound… | — |
| **Practice cycle** | run the cycle | Run the cycle | `sectionsOn` |
| | columns: beats · what sounds | Beats · What sounds | `sections[]` |
| | per-section toggles: click · draw | Click · Show | `sections[].click`, `.show` |
| | order | Order | `sectionOrder` |
| | add button | Add section | — |

#### File

| Section | Now | New label | Key |
|---|---|---|---|
| **Song file** (was file) | choose file… / none | Choose file… / No file | `filePath` |
| | play file | Play | `playFile` |
| | file volume | Volume | `fileVolume` |
| | divider: against the grid | Lining up with the beat | — |
| | file beats | Length (beats) | `fileBeats` |
| | set tempo from file | Set tempo from file | — |
| | file shift (beats) *(moves above offset)* | Shift (beats) | `fileShift` |
| | file offset (ms) | Offset (ms) | `fileOffsetMs` |
| | divider: follow tempo | Following the tempo | — |
| | time stretch | Stretch to tempo | `fileStretch` |
| | warning: needs \`file beats\` | Needs a length in beats. Playing at its own speed. | — |
| | divider: a–b repeat | Repeat part of the file | — |
| | repeat a–b | Repeat A–B | `fileRepeatOn` |
| | a (beats) / b (beats) | From beat / To beat | `fileRepeatStart` / `fileRepeatEnd` |

#### Loop

| Section | Now | New label | Key |
|---|---|---|---|
| **Looper** | *(the on/off switch is pinned above the tabs)* | | |
| | beatsToLoop | Loop length (beats) | `beatsToLoop` |
| | loop echoes | Echoes | `loopEchoes` |
| | loop echo gain | Echo volume | `loopEchoGain` |
| **Live input** | audio monitor | Hear live input | `audioMonitorOn` |
| | visual monitor, **moved** from visual | Draw live input | `visualMonitorOn` |
| **On speakers** | out of the looper, **moved** from signal › speaker bleed | Keep the app's sound out of the loop | `bleedCancelAudioOn` |
| | stop runaway | Stop feedback runaway | `loopFeedbackGuardOn` |
| | *(new hint, shown if bleed hasn't been measured)* | Measure speaker bleed in Setup first. | — |

"Draw live input" goes next to "Hear live input" because together they answer
one question: are you seeing and hearing yourself, or only the echoes?

#### Display

| Section | Now | New label | Key |
|---|---|---|---|
| **Panes** (was views) | arrangement / "2 across x 1 down" | Arrangement / "2 across × 1 down" | `viewCols`, `viewRows` |
| | chain panes | Run panes in sequence | `viewsSequential` |
| | view 1, view 2… | Pane 1, Pane 2… | — |
| **Pane 2** *(new heading naming the selected pane; just "Pane" when there is one)* | divider: content | What it shows | — |
| | channel picker | Channels | `channels` |
| | kind: waveform / spectrogram | Display: Waveform / Spectrogram | `kind` |
| | spectrogram channel · gain · floor | Spectrum of · Brightness · Floor | `spectrogram*` |
| | divider: layout | Rows | — |
| | one row per note… *(built)* | One row per note… | — |
| | beats per row | Beats per row | `beatsPerRow` |
| | left margin / right margin | Lead-in (beats) / Lead-out (beats) | `marginLeft` / `marginRight` |
| | divider: drawing | Drawing | — |
| | visual gain | Waveform size | `visualGain` |
| | split up/down | Split channels top/bottom | `splitChannels` |
| | bar color mode | Color by loudness | `barColorMode` |
| | refresh at cycle end | Redraw once per pass | `refreshAtCycleEnd` |
| | divider: overlays | Overlays | — |
| | show flux / flux gain | Show attack strength / Attack strength size | `showFlux` / `fluxGain` |
| | show onsets | Show note starts | `showOnsets` |
| | divider: colors & grids | Colors | — |
| | row colors | Row colors | `rowColors` |
| | row color pattern (up) / (down) | Row color pattern (top) / (bottom) | `rowColorPattern` / `rowColorPatternDown` |
| | *(new divider)* | Grids | — |
| | grid list; offset tooltip | Grid list; "shift" in its help text | `grids` |
| | add grid | Add grid | — |


#### Layout

A tab of its own rather than a section under the panes: it is short, but it
distracted from the busiest tab in the panel.

| Section | Now | New label | Key |
|---|---|---|---|
| **Look** (was visual › layout) | background | Background | `waveformBackground` |
| | grid width | Grid line width | `gridWidth` |
| | divider: between panes | Between panes | — |
| | pane gap / gap color | Gap / Gap color | `paneGap` / `paneGapColor` |

Layout is last among the drawing tabs because it's touched least; the per-pane
settings are what Display is really for.

#### Setup

| Section | Now | New label | Key |
|---|---|---|---|
| **Audio devices** (was device) | input / output / system default | Input / Output / System default | `audio-prefs.json` |
| | running: in X · out Y | Now using: X → Y | — |
| | restart to apply | Restart to apply | — |
| **Latency** (merged: the calibration from device, plus the latency section) | calibrate / measure latency | Measure latency *(the "calibrate" label goes)* | — |
| | input level · match · agreement | Input level · Match · Agreement | — |
| | apply / discard | Apply / Discard | — |
| | bufferCompensation | Latency (frames), with "≈ 98 ms" beside it | `bufferCompensation` |
| **Input** (merged: gain plus input channels) | input gain | Input gain | `audioInGain` |
| | columns: col · opacity · gain · pan | Color · Opacity · Display level · Pan | `channelStyles`, `channelGains`, `channelPans` |
| **Playing on speakers** (was speaker bleed) | measure bleed, *moves to the top of the section* | Measure speaker bleed | — |
| | hide own output | Hide the app's sound from the picture | `bleedCancelOn` |
| | keep tracking | Keep adapting | `bleedTrackOn` |
| **Updates** | updates | Updates | — |

#### Analysis

| Section | Now | New label | Key |
|---|---|---|---|
| **High-pass filter**, **moved** from signal | high pass | High-pass filter | `highPassOn` |
| | cutoff (Hz) | Cutoff (Hz) | `highPassHz` |
| | filter the sound too | Filter what you hear too | `highPassAudio` |
| **Spectrum**, **moved** from visual | spectrum analysis | Spectrum analysis | `analysisOn` |
| | fft window | Analysis window | `analysisWindow` |
| **Note starts**, **moved** from visual | flux band low (Hz) / high (Hz) | Attack band low (Hz) / high (Hz) | `analysisBandLow` / `analysisBandHigh` |
| | onset threshold | Threshold | `onsetThreshold` |
| | onset min gap (ms) | Minimum gap (ms) | `onsetMinGap` |
| | onset offset (ms) | Offset (ms) | `onsetOffset` |
| **Diagnostics**, **moved** from visual | frame time | Show frame time | `showFrameTime` |

### Calls made in this arrangement, worth a second look

- **Tempo and the looper switch move up next to the transport** (confirmed
  2026-09-13). They're the controls reached for most during practice, and ⌘L
  alone isn't discoverable.
- **The bleed controls are split.** "Keep the app's sound out of the loop" goes
  to Loop, because it changes what the looper records, next to "Stop feedback
  runaway". Measuring and the picture-side switches stay in Setup. The cost is
  that it depends on a measurement made in another tab, which is why there's a
  hint.
- **"Accents"** for the drums' per-hit gains. Accurate for how they're used, but
  the field takes any multipliers, so the help text says so.
- **"Waveform size"** for `visualGain`. It scales the drawing, not the sound,
  and "gain" next to "input gain" invited confusing the two.
- **"Offset" in Analysis › Note starts** is the one use of the word that isn't
  about a sample's attack. It still means "move by this many ms", so it stays.
- **Nothing is hidden behind "more" expanders yet.** Rearranging and relabelling
  first shows how long each tab really is. Expanders are a follow-up if a tab
  still scrolls.

Unchanged by all of this: the open tab stays plain React state, and hidden tabs
stay mounted.

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

### Pattern builder

Decided 2026-09-13: worth building.

- A grid of cells (steps across, optionally one row per sound) where clicking
  toggles hits. It **writes rhythm text** in the existing syntax into the field,
  and that text is what gets stored. The builder never becomes a second format.
- One-way to start: builder → text. Reading arbitrary text *back* into cells
  only works for text that is a plain step pattern (`[1, 0, 1, 1]`-shaped), and
  the builder should say "this rhythm can't be shown as steps" rather than
  simplifying someone's hand-written rhythm.
- Choose the smallest text that reproduces the pattern, so the output teaches
  the syntax instead of hiding it: four even hits come out as `4:1`, not a
  bracketed list.
- Opens from a button beside rhythm fields (click, drums, grids), next to the
  syntax "?".
- Check each shape it can produce by parsing the generated text with parser2
  and comparing note times with the cells, in a temp test.

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

## Decisions (2026-09-13)

- **Examples live in a separate picker** from saved presets.
- **Sentence case** for every label. Lowercase may be tried afterwards as a
  style choice; since it's text only, it's cheap either way.
- **Pattern builder: yes**, writing the existing rhythm text (see Phase 3).
- **Random tempo drill is an advanced example.**
- **Phase 2 comes first**, before the setup and examples.
- **Relabel before the help panel**, so descriptions are written once in the
  final vocabulary. **The help area can be hidden** (? in the transport row,
  remembered per machine), and **explanatory tooltips are replaced** by it.
  Built 2026-09-14: the mechanism is `src/help.tsx` and the strings are
  `src/helpText.ts` (not `src/help.ts` as first written, which would collide
  with the component file).
- Not built yet from this phase: showing an expression field's resolved value
  in the help area, and the "measure speaker bleed first" hint on the Loop tab
  (the bleed status lives inside `BleedMeter`; the help text says it instead).

## Open questions

- Does first-launch setup restart the app when the device changes, or defer
  that until the end of setup? Deferred until Phase 1 is being built.
