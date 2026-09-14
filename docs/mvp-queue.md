# MVP queue

Things to take a first pass at without the owner in the loop, ranked by how
much judgement they need. Written 2026-09-14, after the panel split and the
built-in kit landed.

**Read the code before trusting this file.** It was written from a session
whose picture of the repo was already stale in two places -- the kit and the
panel split both landed without it noticing. Every entry names the files it
expects to touch; check them.

## Two constraints that decide how this gets run

- **Builds cannot run concurrently.** `scripts/tauri.mjs` frees
  `/Volumes/<productName>` before a build and **exits 1 when it cannot**, and a
  second build starting mid-way would detach the first one's volume. A build
  also notarizes, which is a network round trip to Apple. So: only one build at
  a time, ever. If work is parallelised, the agents doing it must not build --
  the builds get serialised afterwards.
- **Most of these touch the same four files.** `structs.rs`, `main.rs`,
  `config.ts` and the panel tabs are in nearly every entry. Parallel edits will
  collide. Prefer running these in sequence; only fan out entries whose file
  lists are disjoint (1 and 2 are, and are the only pair that clearly is).

Every change still follows the standing rules: `yarn tauri build` after each
one, exactly 3 Rust warnings, temp tests written/run/deleted, comments explain
*why*, nothing allocates on the audio thread.

---

## Tier 1 -- fully specified, no taste calls

### 1. `chances`: per-hit probability on a drum voice

A list beside `gains`, same `parseNumberList` "1,0.5x3" syntax, indexed by
**hit count** with `rem_euclid` so a length that doesn't divide the rhythm
drifts rather than resetting -- the property `gains` has deliberately.

- A hit that loses the roll **keeps its slot**: the rhythm defines the times, so
  nothing about the part's length or `end` changes, and the hit counter still
  advances, which is what keeps `chances` and `gains` in phase.
- The roll happens at the trigger, which is `offset_beats` early. Still exactly
  once per hit.
- `rng` is already on the audio thread (`rand::thread_rng()` in `main.rs`, used
  by the click and the bleed probe). One comparison per trigger, no allocation.
- **Do not** reach for `choose`/`range` here -- a roll is deliberately sticky
  and a live one in a field would mean no number in the app holds still. See
  *Parameters and expressions* in CLAUDE.md.
- Empty means every hit sounds, exactly as empty `gains` means unity.
- Needs `#[serde(default)]` and an optional TS field read through a helper, the
  same treatment `shift` and `gains` got.
- Expression-backed only if it is added to `resolveRustConfig`'s walk *first* --
  that ordering is a documented trap.

Files: `structs.rs`, `main.rs` (the drum trigger), `config.ts`, `DrumList.tsx`,
`helpText.ts`.

### 2. Pane names

A per-pane name, optionally drawn in the pane. Independent of every other pane
feature, and wants none of the pane-list work below.

- A new `ViewConfig` key, so `normalizeView` gives an old saved pane a default.
- Drawn on the pane's own canvas, which means it is painted onto the *visible*
  surface after the layer blit, alongside the grids -- not into the layer, which
  the sweep would erase a column at a time.
- Empty means draw nothing, which is how every pane behaves today.

Files: `config.ts`, `panel/DisplayTab.tsx`, `App.tsx` (the draw path).

---

## Tier 2 -- clear, but each has one call to make and flag

### 3. Record the session to WAV

- **WAV only.** A header is 44 bytes; MP3 means an encoder dependency and a
  licensing conversation to save a file you would convert anyway.
- **Nothing touches the disk on the audio thread.** The callback pushes into a
  ring and a writer thread drains it -- the shape `stretch.rs` uses for the
  off-thread render and `get_samples` uses for the pre-sized swap. Stream to
  disk rather than buffering, since a practice session is long.
- **The call to make:** what gets recorded. Both are already sitting in the
  callback, so it is a choice rather than work -- suggest two switches, the
  input and the output mix, defaulting to the input.
- Starting and stopping is a command; the file path comes from a save dialog,
  the way export already does.

Files: new `recorder.rs`, `main.rs`, `commands.rs`, `structs.rs`, a panel
section.

### 4. Loop recording cycles

MVP is a fixed even-length on/off: record for N beats, don't for N. Worth
generalising in the same pass if it stays simple -- "record 1 cycle in 4" and a
list of alternating lengths are both the same mechanism, and `parseNumberList`
already does lists, groups and repeats.

- **This is the alternating record/playback already named as the real fix for
  looper feedback** (see *Out of the looper*), so it closes that thread.
- **The call to make:** it arguably belongs as a field on `Section`, which is
  already "for this many beats, these sound" -- two independent cycle
  mechanisms both gating the looper is the tangle `clickToggle` was retired to
  avoid. But a section wrap also restarts the beat, rerolls the parameters and
  clears the looper, so a record cycle that must run *across* those cannot be a
  section. **For the MVP: standalone keys, and say so plainly** so the decision
  is still open.
- Gate the *write* into the loop buffer, not the read. `loop_written` already
  exists for "nothing recorded before a restart may play back".

Files: `structs.rs`, `main.rs`, `config.ts`, `panel/LoopTab.tsx`.

### 5. Global start/stop -- a spike, not a feature

Answer one question before building any UI: **does Tauri v1's `globalShortcut`
need an Accessibility grant on macOS?** Input monitoring does; Carbon's
`RegisterEventHotKey` historically does not, and which one the plugin uses
decides whether this is pleasant or a permissions mess. `allowlist.all` is
already true, so there is nothing to enable.

Also settle what a bound key does while a text field has focus -- ⌘P/⌘L already
take theirs unconditionally, on the stated grounds that none is a text-editing
key.

**Bindings are not a preset key.** They belong to the person and the keyboard,
not the music; a shared preset must not rebind someone else's keys. Same
argument that put the device choice in `audio-prefs.json`.

Report the finding before writing the UI.

---

## Tier 3 -- wants the owner

- **A reference loop** (capture a phrase once, play it back for ever). Falls out
  of recording, and is a button on top of it. **Build it on the file player, not
  the looper**: the looper is a multi-tap delay, and what this wants is a buffer
  phase-locked to the beat -- `fileBeats`, position derived from `beat` and
  never accumulated. That gets A-B repeat, `fileShift`, the varispeed and the
  drawing bus for free. Arming at the next cycle is `section_bounds`. The UX --
  count-in, arming, clearing -- is the part to agree first.
- **Interchangeable kits.** Named sounds already exist (`samples/kit.json`, ids
  that travel with a preset). What is open is pointing the same name at a
  different file, which is a mapping and a store, and a taste call about what a
  kit *is*.
- **Pane remove / duplicate / reorder / arbitrary layout.** Breaks the
  documented `views.length === viewCols * viewRows` invariant, where the
  arrangement is the only control over how many panes exist. This is a move to
  an explicit pane list plus a layout spec, not a few buttons. Wide blast
  radius.
- **The drum grid UI.** Big and taste-heavy. It must *write rhythm text* and
  never become a second format -- already the stated rule for the pattern
  builder in `docs/approachability.md`.
- **Onsets.** Needs ears, not a spec. Already the top item in *Verification*,
  with the drums bus named as the reference to calibrate against.
- **Offline drum render.** Requires extracting the drum logic out of the render
  closure, which owns everything by value. That is the riskiest area in the
  codebase and the same extraction the AU port needs -- worth doing on purpose,
  not as a side effect.

---

## Log

Appended as work happens: what was attempted, what landed, what was left.

**1. `chances` — landed 2026-09-14.** Per-hit probability beside `gains`, same
syntax, same `rem_euclid` indexing, expression-backed by the documented
two-step. A lost roll keeps its slot and advances the hit counter, so the two
lists stay in phase; the half-open draw is its own clamp, so an out-of-range
value is sensible rather than a refused push; an empty field clears the key,
which `gains` cannot do and does not need to. Temp-tested both sides (TS: the
walk, re-resolution, a bare array, a vanished parameter; Rust: the phase
property, drift, the out-of-range cases, serde default) and deleted. Built
clean, 3 expected warnings. Open: the drum row now has six controls and gets
cramped at a narrow panel, and a dropped hit is invisible rather than drawn
differently.

**2. Pane names — landed 2026-09-14.** A `name` on `ViewConfig`, drawn top-left
on the visible canvas after the layer blit and the grids, sized in CSS pixels
times the pane's own ratio, inked black or white off `waveformBackground`'s luma
rather than taking a colour key. Empty is the default and draws nothing.
`TextInput` in `Input.tsx` is new, called by name like `ColorInput` rather than
dispatched on type. Temp-tested restore, arrangement growth/shrink and
`copyView` isolation, then deleted. Built clean, 3 expected warnings. Open: the
corner, 11px and 0.5 alpha are taste calls made without seeing them, and a long
name is clipped at the pane edge rather than truncated.

**3. Record the session to WAV — landed 2026-09-14.** `recorder.rs`, three
commands, a section at the foot of the file tab. Callback appends into a
capacity-fixed buffer; a writer thread swaps and writes outside the lock; an
overrun drops and counts. 32-bit float because the output bus is unclamped.
Whole header rewritten on every flush, so a killed process leaves a readable
file. **The call made:** two switches, input and output mix, defaulting to
input; both on gives one file `inputs + 2` wide rather than two files or a sum.
Temp-tested header bytes, symphonia round trip at 1/2/3 channels, size patching,
overrun-without-realloc, double stop, refused start. Built clean, 3 expected
warnings. Open: paused is not recorded (arguable), the switches reset on relaunch,
and the drop path has never met a real disk stall.

