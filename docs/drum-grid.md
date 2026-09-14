# The drum grid

Sounds down the y axis, columns across, the column count anything you like, and
the underlying pulse a number *or a list* -- `[.3,.2]` for swing, `[.3,.3,.2,.2]`
for a Dilla feel. Several grids run at once, on their own cycles, which is
polymeter.

**It is an editing surface, not a second format.** Everything it produces is an
ordinary drum voice: a rhythm, a gains list and a chances list, exactly as if
they had been typed. That is the standing rule for the pattern builder in
`docs/approachability.md`, and it is what keeps a grid from being a thing the
audio thread has to learn about.

## What a grid is

- **A length in columns**, not in beats. The beats follow from the pulse.
- **A pulse**: a number or a list, in `parseNumberList` syntax like
  `beatsPerRow` -- so `bar/n` follows a parameter and `[.6,.4]x2` is a group.
  *Not* the rhythm grammar; those are two different `x` operators and the grid
  wants the number-list one.
- **Rows**, each an existing `DrumVoice`. A row inherits the sample, the
  volume, the offset and the shift; the grid owns only its rhythm, gains and
  chances. The same sound in two grids is two voices, which is honest -- they
  are two parts.
- **A restart flag** -- see *Phasing*.

## How a grid compiles

**Every column becomes a note, and an unchecked column is a chance of 0.**

This is the whole trick, and it removes four problems at once:

- **No rest to express.** parser2 has notes and spans, not rests, so a pattern
  with gaps would otherwise have to be written as the gaps *between* hits --
  the `RowPerNote` midpoint trick -- and then the first hit would land at time
  0 whether or not it was in column 0, which needs a rotation or a shift from
  somewhere.
- **`gains` and `chances` can never fall out of phase**, because the hit count
  now *is* the column count. A per-column accent is a per-hit accent, which is
  what the grid wants and what Rust already indexes by.
- **A chance of 0 costs nothing.** The roll fails at the trigger and no
  `SoundingSample` is pushed at all -- unlike a gain of 0, which would push a
  silent sample per column per voice and mix it for its whole length.
- **An all-unchecked row is representable.** A rhythm with no notes is a shape
  nothing downstream survives (`end: 0` is a syntax error on purpose); a rhythm
  with notes that never sound is ordinary.

So **unchecked and "chance 0" are the same state**, and the on/off view is the
chance view rounded to {0, 1}. That is simpler than keeping them apart, and it
is the answer the compilation forces rather than one chosen for tidiness.

- **The grid always writes `chances`**, since unchecked cells are the normal
  case.
- **It writes `gains` only once some cell carries one.** Left alone, a
  hand-typed `1, 0.6x3` survives -- and that list deliberately *drifts* against
  a bar it doesn't divide, which is a trick a grid-owned list can never do. Both
  idioms stay available instead of the grid eating one.
- **The bound is `MAX_LIST_LENGTH`, 128.** Columns times passes must fit it.

## Phasing

The pulse cycles on its own length and the grid cycles on the column count, and
when those disagree the two phase against each other.

**Restart on** (the default): column *i* takes `pulse[i % pulse.length]`, the
pulse resets at the grid boundary, every pass is identical. Five columns against
`[.3,.2]` is `.3 .2 .3 .2 .3` -- 1.3 beats, for ever.

**Restart off**: the pulse keeps running across the boundary. Pass two of that
example is `.2 .3 .2 .3 .2` -- 1.2 beats -- and the pattern only comes back
round after `pulse.length / gcd(columns, pulse.length)` passes. Two, here. Seven
columns against a five-pulse is five passes and thirty-five emitted columns.

- **The emitted rhythm covers the whole period**, tiling the checkboxes across
  it. There is no way to express the phase relationship in a rhythm that repeats
  on one pass, and nothing in the audio thread is going to learn about grids.
- **The grid still shows one pass.** What you edit is the column count you
  chose; what sounds is that pattern walked through the pulse. The panel says
  how long the real cycle turned out, because the number is not obvious and it
  is the thing that will surprise you.
- **So there are no beat markers under carry-over.** A beat lands in a different
  column on every pass, and a marker that is right one pass in two is worse than
  none. Under restart they are exact and worth drawing, since with an uneven
  pulse and even columns the beats fall between columns at irregular places.

## Where the grid lives

- **In the js config**, as `drumGrids`, because it is an editing structure and
  nothing in it reaches the audio thread. What it compiles *to* is the Rust
  config's `drums`.
- **The rhythm text is derived, never authored.** It is still stored -- Rust
  reads `val` -- but the grid is the source and the text is a cache, the same
  relationship `inputText` and `val` already have. It is recomputed on every
  path that resolves the config: startup, `setParameters`, `loadPreset`, the
  restored session, and any grid edit. A cache that can go stale is the trap
  the expression fields exist to avoid.
- **A gridded voice's rhythm field is read-only** in the drums tab, showing what
  the grid produced. Two places to type one answer is the thing being avoided.
- **A row names its voice by index**, the way `sections[].drums` already does.
  This is the weakest part of the design: deleting a voice shifts every index
  after it, so the same fix-up sections need is needed here. A stable voice id
  would be better and is a wider change than this feature.

## The surface

- **A *Grids* section in the drums tab** lists them, with *edit* opening a
  modal and *new grid* making one. A grid owns several rows, so it wants a home
  of its own rather than a button on a drum row.
- **The modal is the grid**: column count, pulse, restart, then the matrix.
  Columns are drawn **evenly**, whatever the pulse -- the panes are where you
  look at where notes actually land, and this is where you say what they are.
  The pulse is shown above the matrix so the unevenness is legible.
- **Adding a row** offers the kit by name, *From a file…*, or a part that
  already exists -- the drums tab's own add menu plus the third option a grid
  needs.
- **A lens switch**: hits, gains, chances. Gains and chances apply to checked
  cells only.

## Deliberately not in the first pass

- **A grid-level shift.** A row is a voice and a voice already has one.
- **Any interaction with sections.** A section names voices; a grid's rows are
  voices; nothing new is needed.
- **Sound letters driving several voices from one rhythm.** parser2 parses them
  and nothing reads them; that is the *Interchangeable drum kits* thread, not
  this one.
