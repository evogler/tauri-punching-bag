# UI redesign handoff (from claude.ai, Sept 2026)

This summarizes two design conversations Eric had in claude.ai about the next
visual pass on the app, plus some product notes. The mockups are in
`ui-mockups.zip` (see "Mockup files" below). Read `CLAUDE.md` and
`docs/approachability.md` first; this doc assumes them.

**Status:** direction only. Nothing here is implemented. Where this doc
disagrees with the code or with `CLAUDE.md`, the code and `CLAUDE.md` win;
flag the conflict rather than silently following the mockups.

## Ground rules Eric set

- **Do not dumb it down.** Keep the text rhythm notation (`[4:3, 3:4]x2,.75`),
  parameters, rolls, practice cycles, and the freedom to build odd grids and
  stacked rows. Approachability comes from clarity and feedback, not from
  removing power or adding a "simple mode."
- **No modes.** Progressive disclosure only.
- **The app is an instrument, not a grader.** It shows where notes land so the
  player can place time on purpose (ahead, behind, on). Avoid anything that
  frames distance from the grid as error: no scores, pass/fail, percentages,
  streaks. See "Legend wording" below.

## Design direction

### Structure
- **Keep the ten-section left rail** (Examples, Presets, Parameters, Play,
  File, Loop, Display, Layout, Analysis, Setup), grouped sound / picture /
  machine, with ⌘1–⌘9, ⌘0 and ⌘[ / ⌘]. An earlier pass replaced it with three
  tabs; that was wrong for the reasons already in `CLAUDE.md` (a tab row
  degrades as sections grow).
- **Status dots on rail items:** amber = something running in that section,
  red = a field there needs fixing.
- **Collapsed rows with one-line summaries**, e.g.
  `Drawing · size 10 · redraw live`. Expanding shows the full controls.
- Transport, tempo and looper switch stay outside the panel, as now.

### Canvas
Nearly untouched. Two additions only:
- **Grid chips** labeling each grid line with its exact offset (`+.125`,
  `+.04`). Labels stay numeric (beat numbers, ms scale, exact offsets) so odd
  grids are described accurately instead of being funneled toward standard
  subdivisions.
- **A legend** for the note-position colors.

**Legend wording (changed after the mockups were made):** the mockups say
"on the note" (green) and "furthest off" (red). That frames distance from the
grid as error, which contradicts the app's purpose. Use neutral language such
as "at the grid" and "earliest / latest," and reconsider green/red, which
reads as right/wrong. The mockups have not been updated for this.

### Rhythm fields
- **Dot-strip preview inside the same input box**, showing the hits the text
  produces.
- **Hovering a bracket group highlights its hits** in the strip.
- **On a parse error, keep playing the last good rhythm** and show a suggested
  fix, rather than stopping.
- Mockups must only use rhythms the grammar in `src/parser2.peg` accepts.
  (One mockup had `2:4 >1`; `>` applies to a single note only. It was fixed
  to `1 r, 1`.) Verify any example text against the parser.

### Expression fields (parameters etc.)
- **Show resolved values inline** in the field, e.g. `bar/n x n` → `0.25 × 16`.
  This moves the unbuilt help-area readout into the field itself.
- Drag on a numeric label to change the number.

### Drum voices
- **One-line lanes:** checkbox, name, rhythm text, preview strip, volume.
  Everything else behind a disclosure.

### Step grid editor (per `docs/drum-grid.md`)
- Drawn on the real model. **Pulse lists change column widths**: pulse
  `[.3,.2]` makes columns alternate wide/narrow so swing is visible.
- **Footer shows the text the grid writes.** The grid is an editor for the
  ordinary rhythm/gains/chances text, never a second format.

### Visual system
- Layered near-blacks instead of nested boxes and borders.
- Instrument Sans for reading (13/18; 600 for headings). JetBrains Mono for
  every number and expression. Tabular numerals.
- Section labels: 11px caps, tracked, replacing boxed group borders.
- **One amber accent reserved for controls** so the waveform's colors stay
  purely data.

Palette from the mockups:

| Role | Hex |
|---|---|
| Canvas | `#0F1214` |
| Field | `#111417` |
| Panel | `#171B1E` |
| Raised | `#1F2428` |
| Hairline | `#2A3035` |
| Text / muted | `#A3ACB2` (also `#7D878E` for dimmer text) |
| Primary text | `#E7EAEC` |
| Accent (controls only) | `#F5A524` |
| Parameter names | `#9FC3FF` |
| Error | `#FF6B5B` |
| Row colors (example) | `#7B93FF` |
| Legend colors (see wording note) | `#8BE3A8`, `#F0806F` |

## Mockup files

`ui-mockups.zip` contains the design canvas's artboards. Each `*.dc.html` is
one screen written in a templating format for the claude.ai design canvas
(`{{...}}` bindings plus a small `DCLogic` class), so treat them as a visual
and structural reference, not as components to paste in. `canvas.json` lists
the boards and their sizes.

| File | Shows |
|---|---|
| `Main.dc.html` | Main window with the Play section open (1280×820) |
| `Rhythm.dc.html` | Rhythm field states (preview, hover, error) and canvas labeling |
| `Examples.dc.html` | Examples section |
| `Parameters.dc.html` | Parameters with inline resolved values |
| `File.dc.html` | File section |
| `Loop.dc.html` | Loop section |
| `Display.dc.html` | Display section |
| `Setup.dc.html` | Setup section |
| `GridEditor.dc.html` | Step grid editor with swing-width columns |
| `Empty.dc.html` | Waiting-for-input state |
| `Tokens.dc.html` | Palette and type |

Not drawn: Presets, Layout, Analysis. They should reuse the same patterns.
All data in the mockups (device names, latency numbers, song files, parameter
values) is placeholder.

Live canvas (Eric's account): https://claude.ai/artifact/MCqNEiv4P4fpigpbgVxXJh

## Suggested order

1. Eric's own Phase 0: watch one friend use the current build without helping.
   Their struggles may reorder everything below.
2. Rhythm field preview + keep-playing-on-error (biggest clarity win).
3. Collapsed rows with summaries, rail status dots.
4. Visual system pass (surfaces, type, accent).
5. Canvas grid chips + neutral legend.
6. Inline resolved values for expressions.
7. Drum voice lanes, then the step grid editor.

## Pre-release checklist (before friends try it)

- Build 3–4 more examples via `yarn example:add` (only 2 of ~8 exist).
  "Loop yourself" and "Count-off, then groove" teach the hardest-to-find
  features.
- Choose the name; replace the Create React App boilerplate README with the
  Phase 5 one-pager (what it's for, screenshot, install, first steps).
- Verify the setup wizard's laptop-speakers path actually catches bleed.
- Make bug reports easy: a "copy diagnostics" button in Setup (version,
  devices, latency, bleed status).
- Test the update path end to end from an older build.
- Freeze features during the trial.

## Product notes (context, not tasks)

- **License:** the repo is public but has no LICENSE file. Eric is weighing
  MIT vs GPL, possibly selling signed binaries while the source stays open.
  Undecided.
- **Mobile:** next step is a proof-of-concept port. On iPhone the screen shows
  either config or the canvas, not both. Keep transport and tempo reachable
  from the canvas. Presets become the main phone interaction; the step grid is
  the likely phone-native creation surface; a keyboard accessory row for
  `[ ] : , x > r` would help text editing. Wired headphones are required;
  watch for iOS switching input to a headset's inline mic and prefer the
  built-in mic.
- **Sharing/sync idea:** presets are small text, so a preset could be encoded
  in a URL that opens the app with it loaded. That same mechanism could back a
  simple static preset-sharing website later.
- **Telemetry idea:** strictly opt-in, anonymous install ID, never audio or
  rhythm text, with a "show me what's sent" view. Possibly self-hosted.
  Not planned yet.
- **Manifesto:** Eric intends to write a short statement of his view of
  practice (the app is for placing time intentionally, not proving playing
  correct or incorrect). A short version may appear in the README and first
  run. The UI should not contradict it.
