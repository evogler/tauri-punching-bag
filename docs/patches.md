# Patches, parameters and triggers — design notes

Where the thinking got to as of 2026-08-30. Nothing here is built yet except
what's noted under **Status**. This is a design record, not a spec — the open
questions at the bottom are genuinely open.

## The goal

Quickly flip between named bundles of settings without hand-editing the panel:
"toggle the grid view", "looping on/off", "swap the drum pattern *and* the grid
together". Bound to keys now, other input sources later.

## Parameters and expressions

The more valuable half, and the one that makes everything else smaller.

A **parameter** is a named number, e.g. `n = 16`. An **expression** is arithmetic
over parameters stored in a config field in place of a literal.

```
n = 16, bar = 4
rows:  bar/n x n   ->  0.25 x 16     (16 rows, a 16th note each)
grid:  {n/bar}:1   ->  4:1           (4 subdivisions a beat, 16 across the bar)
```

Note `bar/n`, not `n/bar`, for the rows — `n/bar` would give 16 rows of 4 beats.

Why this comes first: "switch to 16ths" stops being a patch that rewrites
`beatsPerRow` and every grid, and becomes a patch that sets one key, `n`.
Patches overlap on one key instead of five, which makes the whole conflict
question quieter.

### Language

`+ - * / ( )`, numbers, parameter names, and `min` / `max` / `round`. Nothing
else. Deliberately not a scripting language.

### Where expressions are written

- **Numeric and number-list fields** take a bare expression: `bar/n x n`.
- **Rhythm text** (grids, click, drum rhythms) takes `{...}` interpolation:
  `{n/bar}:1`. Braces only where there's already other syntax to collide with —
  the rhythm fields go through the generated PEG parsers, so an expression is
  substituted for its value *before* parsing rather than by touching the
  grammar.

### Storage

`{inputText, val}` — the text you typed plus the evaluated result — which is
already exactly the shape `Rhythm` uses. `unwrapValues` is recursive and already
strips any object with a `val` down to `val` before the config goes to Rust, so
**expression-backed fields cost nothing on the Rust side.**

### Known wrinkles

- The repeat count after `x` must be a whole number. `bar/n x n/2` at `n = 7`
  wants 3.5 rows — round it, keep the existing 128 cap. Rejecting means the
  field goes red mid-typing during a parameter sweep.
- Guard division by zero. `n = 0` is one backspace away from `n = 16`.
- Invalid input: red border on the field, don't apply. (Today
  `NumberArrayInput` swallows the error and silently keeps the last good value,
  which reads as the field ignoring you.)
- **`beatsPerRow` changes shape** from `number[]` to `{inputText, val}`. That is
  the `loopFeedback` trap again: restore merges saved values over defaults, so a
  saved array lands on top of the new object and `Math.max(...beatsPerRow)`
  returns `NaN` — blank pane. Fix with an explicit migration in `migrateViews`
  (wrap an array as `{inputText: formatNumberList(arr), val: arr}`) rather than
  a rename, since `migrateViews` already does this sort of work and a rename
  loses saved layouts.

## Patches

A **patch** is a sparse set of settings. The live config is the base with every
*active* patch merged over it.

### Why layering rather than save-and-restore

The trap is "swap these settings, and remember what they were so I can put them
back". Two patches both holding restore-state for `grids` fight, and the order
you switch them off changes where you land.

A patch that stores only **what it sets** needs no restore state: switching it
off removes a layer and whatever's underneath shows through. Overlap stops being
a correctness problem and becomes a display problem — show which patch owns a
key.

### Ordering

Conflicts resolve by the patch's **position in the list**, fixed — *not* by the
order you activated things. Same active set always gives the same result
whatever order you pressed things in. Activation-order-wins feels natural in the
moment but means the visible state can't be reconstructed from the toggle states
alone.

Patches don't accumulate: a patch is on or off, membership in a set. Pressing
its key twice turns it on then off. Reorder by dragging — `GridList` already
implements the drag idiom and it's reusable.

### Groups

A patch may carry a **group tag**; at most one member of a group is active. That
is what makes "straight / swung / triplet" behave as variants, while ungrouped
patches (grids off, looping on) stay independent. Toggles and preset variants
are the same mechanism with one extra field, not two features.

### Authoring — no recording

Rejected: a record-changes flow. You usually already have it the way you want it
by the time you decide to save it.

**"New patch from current state"** lists every key differing from a baseline
(the saved preset by default), each with a checkbox, pre-ticked. Untick what you
didn't mean. A "show all settings" toggle lets you tick a key that *doesn't*
currently differ, which is how a one-key "grids off" patch gets made without
touching anything first. A "+" beside any panel field adds just that key to the
patch being edited.

### Per-view keys

Some settings exist once per pane, so a patch entry has to say which pane.
Decision: **per-key entries with a pane target**, either an index or "all panes",
inferred when the patch is created (every pane changed the same way -> "all")
and overridable with a checkbox. Entries whose pane no longer exists are skipped
silently.

Whole-pane granularity was considered and rejected: it costs all composition
within a pane (two patches could never both apply), and the machinery to produce
"the whole pane" is the same machinery that produces per-key entries, just
throwing away which keys moved. Flagged as the most likely thing to want
changing.

### Editing a key a patch is overriding

Unresolved, current best idea: the field shows the effective value with an
always-visible badge naming the layer an edit will land in, and typing edits
*that* layer. The danger is invisible redirection, not redirection as such — with
the destination on screen it isn't magic. Read-only-while-overridden is the safe
alternative but means switching patches off to edit anything.

## Undo

Considered as a *replacement* for layering ("patches just apply, undo backs
out") and rejected — it leaves out the toggling, which is the point. Undo is a
timeline; patches are state. Apply A, nudge bpm, undo — you undo the bpm nudge,
not A. There's no "switch A off but keep everything since". You also lose the
same-key-flips-it-back gesture, and any display of what's currently on.

**But build undo anyway**, as an orthogonal feature. There's currently no way
back from fat-fingering a `beatsPerRow`, and it's cheap:
`makePreset(rustConfig, jsConfig)` already produces a complete serialisable
snapshot, so a ring buffer of those is most of the work.

## Triggers

Bindings map `(source, code) -> trigger id`; patches subscribe to trigger ids.
The patch layer never learns what a MIDI port is, so new input sources are
additive.

Keyboard first. The only real care is not firing while a text input has focus.

MIDI later — and check whether Web MIDI works in Tauri's WKWebView before
designing around it; if not it's the `midir` crate on the Rust side plus a new
event channel to the frontend, which is a project rather than an addition.

Events carry press *and* release even though nothing will use release at first
(no momentary use case: settings get set, then the instrument gets played for a
while). It's one field now and a rewrite later.

## Fallback if layering feels too heavy

Patches that record the current value of each key when switched on and write it
back when switched off. Real toggling and a real on/off display, none of the
ordering machinery. Only fails when two active patches touch the same key and
are released out of order — avoidable by construction at first, and layering can
replace it later.

## Status

- Parameters and expressions: **built**. `src/expression.ts`,
  `src/ParameterList.tsx`, `resolveJsConfig` in `src/config.ts`. Expression
  fields so far are a view's `beatsPerRow`, `marginLeft`, `marginRight` and
  `visualGain`, plus `{...}` interpolation in grid rhythm text. The click and
  drum rhythms and drum `gains` still take literals only -- they're Rust-side
  keys, so re-resolution would have to walk the rust config too.
- Everything else: not started.
