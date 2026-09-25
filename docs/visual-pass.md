# The visual pass

Working plan for moving the app toward the design canvas of 2026-09-23.
`temp-claude-convo/ui-redesign-handoff.md` is the direction and the palette;
the artboards are in `ui-mockups.zip` beside it.

**Phases 1-4 are built**, plus the drum lanes out of the later list. Phases 5
and 6 are not. Two things the mockups draw were built and then removed on the
owner's objection: the top bar's input meter and its latency figure -- see the
top-bar notes in `CLAUDE.md` for why.

The handoff's own rule holds: where the mockups disagree with the code or with
`CLAUDE.md`, the code wins and the conflict gets written down rather than
followed. The conflicts found so far are at the end.

## The finding that sets the order

**There is no token layer, and that is the whole cost of this work.** The panel
is styled in ~240 inline `style={{}}` blocks across 30 files, with ~130
hard-coded hex literals among them (`#aaa` forty times, `#e86` eleven, `#777`
nine), plus the systematic rules in `src/index.css`. `waveformBackground` and
`paneGapColor` are a third source, and they are *config keys* rather than
style at all.

So "change the palette" is not a small diff today. It is a hundred and thirty
hand edits, and doing it that way means every future change is another hundred
and thirty. **The first move is to make repainting possible once**, and the
first move is invisible.

The corollary is the ordering rule for everything below: **a step that changes
how something is expressed and a step that changes how it looks never go in
the same commit.** Otherwise a token wired to the wrong place and a colour
decision you dislike are indistinguishable when you look at the result.

## Phase 1 — tokens, at today's values

One `src/theme.ts` and one `:root` block in `index.css` holding the same
palette the app already draws. Then the mechanical sweep: every hex literal
becomes a token reference.

- **The app looks identical when this lands.** That is the acceptance test, and
  it is one you can run by eye in a second. A pixel that moved is a mistake.
- Both halves are needed because both kinds of site exist: CSS custom
  properties for `index.css` and anything that could become a class, a plain TS
  object for the inline styles, which cannot read a custom property without
  going through `var()` in a string.
- Tokens are named by **role, not by value** -- `surface.panel`, `text.muted`,
  `accent`, `hairline` -- or the rename is just a second spelling of `#444`.
- The data colours stay out of it. `channelStyles`, `rowColors` and the grid
  colours are *config*, chosen per pane and carried in presets; folding them
  into a theme would make a user's palette a build-time constant.

Cost: mechanical, an afternoon. Risk: low, and self-checking.

## Phase 2 — flip the palette

Now a ~20-line diff in one file, and a real one-commit revert if it is wrong.

| | now | mockup |
|---|---|---|
| Canvas | `#222222` (config) | `#0F1214` |
| Panel fill | `#444` | `#171B1E` |
| Field | `#2b2b2b` | `#111417` |
| Raised | `#3f3f3f` | `#1F2428` |
| Hairline | `#525252` / `#777` | `#2A3035` |
| Accent | `#4a86d8` blue | `#F5A524` amber |
| Body | system sans 14px | Instrument Sans 13/18 |
| Numbers | same as body | JetBrains Mono, tabular |

Three things inside this phase that are decisions rather than transcription:

- **The fonts must be bundled, not linked.** Every artboard pulls Instrument
  Sans and JetBrains Mono from `fonts.googleapis.com`, because an artboard is a
  web page. This is a Tauri bundle with no network guarantee, and a webview
  that cannot reach Google silently falls back to the system stack -- the
  design's most distinctive move, gone, with nothing in any log. Ship the
  `woff2` files as a resource with a real `@font-face` and a real fallback
  stack.
- **The canvas background is config, so changing the default moves nobody.**
  `waveformBackground` defaults to `#222222` and a saved session restores over
  it, so every existing install keeps the old ground under the new panel. Same
  shape as `onsetThreshold`, and the same answer: migrate *exactly* the old
  default to the new one in `migrateRust`, and leave any other value alone
  because it was typed on purpose.
- **One accent means the amber is for controls only.** The waveform's colours
  have to stay purely data, which is the rule that makes the picture readable.
  The paused transport going red is the one deliberate exception and it stays.

## Phase 3 — the top bar

The single biggest change in the mockups that is pure layout, and the one that
makes it read as a different application.

Today the transport lives *inside* the panel (`PanelHeader`), so the window is
two columns and nothing spans them. The mockup puts a 56px bar across the top:
transport, tempo stepper, looper pill, then a **section / beat / pass readout**,
the loaded preset or example in the middle, and input level, latency and the
help toggle on the right.

- **It is not only cosmetic.** `2 Groove · beat 3.25 · pass 2/4` does not exist
  anywhere today, and it answers the question the practice cycle raises every
  time it is switched on -- which section am I in, and how far through. The
  input meter and the latency figure likewise exist only in Setup, which is the
  one section you are not in while playing.
- It gives the panel its width back, which every later phase spends.
- Nothing about the draw path changes: the panes are still a grid measured from
  their own boxes.

Do this **after** the palette, not before. A layout change against the old
colours reads as broken twice over.

## Phase 4 — the field, which is where the app is actually used

The craft layer. Small, cheap, and where "repainted" becomes "designed".

- **Resolved values inline**: `bar/n x n` followed by a dim `= 0.25 × 16`. The
  numbers already exist -- this is a render, not a computation -- and it lives
  in `Input.tsx`, so every expression field gains it at once. The parameter
  list already shows its own resolutions; this is the same idea everywhere else.
- **Monospace and tabular numerals on every number**, so a column of values
  stops jittering as it changes.
- **A switch for a section, a checkbox for a list item.** The mockups draw
  CLICK, DRUMS, LOOPER and PRACTICE CYCLE with a pill toggle in the caption row
  and keep checkboxes for the drum voices. That distinction is worth keeping:
  it says at a glance which switch turns off a whole group.
- One label-left, value-right row shape used consistently, which is the
  "shared vertical axis" the current `index.css` notes already name as the next
  pass.

## Phase 5 — the dot strip

The handoff calls this the biggest clarity win, and half of it already works:
**keeping the last good rhythm on a parse error is current behaviour**
(`invalidBorder`, `src/Input.tsx:49`). What is new is the picture and the
suggestion.

- A strip of dots under the text, inside the same box, at the times the rhythm
  actually produces. The parser is already there and already runs on every
  keystroke, so this is drawing what is already computed.
- **Hovering a bracket group highlights its hits** -- the one part that needs
  the parser to hand back spans, not just times.
- The error state gets a sentence and a fix button: *`swng` isn't a parameter.
  Still playing the last rhythm that worked.* That sentence is the feature. The
  red border says something is wrong; only the sentence says what, and only the
  second half says the sound is still fine.
- **Syntax colouring is a separate, harder thing** and should not be bundled
  in. Colouring `[`, `:`, `x` and parameter names inside a real `<input>` means
  an overlay aligned to the text, which is the classic way to get a field that
  looks right and behaves wrong. The dot strip needs none of it. Take the strip
  first and judge whether the colour is still wanted.

## Phase 6 — the canvas

Deliberately last among the visual phases, because the canvas is the part that
currently works.

- **Grid chips**: each grid line labelled at the top of the pane with its exact
  offset, `+0` and `+.125`, in the grid's own colour. This is the thing that
  makes an odd grid describable instead of approximated, and it is a few lines
  in the draw path -- it goes on the visible canvas after the layer blit, with
  the pane name, for the reason the pane name already does.
- **The legend is the part to drop.** See the conflicts below.

## Later, in rough order

Each of these is a feature with logic behind it, not a paint job, and none
blocks the ones above.

1. **Collapsed rows with one-line summaries** (`Drawing · size 10 · redraw
   live`). Needs a summary string per group -- small, but one per group.
2. **Rail status dots**, amber for running and red for needs-a-fix. Needs a
   per-section predicate that does not exist; the error half can reuse whatever
   already turns a field red.
3. **Drum voices as one-line lanes** with everything else behind a disclosure.
   The row already carries six controls and `chances` made it seven.
4. **Parameters' "where they're used"** -- a reverse index from each parameter
   to the fields referring to it. `referencedNames` already exists per field,
   so this is a walk of the config rather than new parsing.
5. **The step grid's swing-width columns**, per `docs/drum-grid.md`. The
   matrix currently draws even columns on purpose; the mockup draws them
   proportional to the pulse. Both arguments are in that doc and this is a
   reversal of the one it settled, so read it before changing it.
6. **The loop's Live / Echo 1 / Echo 2 strips.** New data, not new drawing:
   nothing publishes the individual taps today.
7. **Examples with thumbnails** -- a small SVG per example. Cheap and it makes
   the picker read as a picker rather than a list.

## Where the mockups are wrong

Six, found by reading them against the code.

- **The legend contradicts itself and the app.** The handoff already says
  "on the note / furthest off" frames distance from the grid as error and must
  go. The stronger point is that it is *redundant*: the two lines are the
  target and its antipode that `RowPerNote` writes, and the grid chips already
  name them exactly, `+0` and `+.125`. A chip that states the offset is both
  neutral and more informative than a legend that judges it. **Keep the chips,
  drop the legend**, and let the grid's own colour be the only key it needs.
- **`Echoes` help text is wrong.** The mockup says *0 is a plain looper: one
  pass, replaced by the next*. In the code one pass then silence is
  `loop_echoes = 1, loop_echo_gain = 1`, which are the defaults; 0 echoes means
  no playback at all.
- **Latency collapsed to one "agreement 0.97" figure loses the distinction the
  measurement exists to make.** The calibration deliberately shows four numbers
  with their thresholds, because "too quiet" and "loud but not locking" need
  opposite responses from the person reading it. A single confidence number
  tells them neither.
- **The file waveform with A-B handles is drawn as though it exists.** It is
  deferred on purpose -- per-pixel peaks of a whole file is the wrong first
  answer for a long one, and a region and a decimation step come before any
  drawing code.
- **Three of the dimmest pairs fail contrast**, measured rather than eyeballed:
  the rail's shortcut digits `#5E686F` on `#141719` at **3.16:1**, the rhythm
  strip's tick labels `#6B757C` on `#111417` at **3.93:1**, and `#5E686F` used
  as a separator on the panel at **3.04:1** -- all at 10-11px, where the bar is
  4.5:1. Everything above them is fine: `#7D878E` is 4.73 on the panel and 4.91
  on the rail, `#A3ACB2` is 7.51, `#E7EAEC` is 14.34. So the fix is one line in
  the token file -- retire `#5E686F` and `#6B757C` as text colours and let
  `#7D878E` be the floor -- and it is much easier to do there than to find
  later in thirty files.
- **Google Fonts.** Covered in phase 2, repeated here because it is the one
  that fails silently.

## What the mockups get right that is not obvious

Worth naming, so it does not get lost in the palette.

- **The rail survived.** An earlier pass replaced it with three tabs; this one
  keeps all ten sections, the three groups and the digits, and draws the digit
  in the button. That was the right call for the reasons already written down.
- **Every number is monospace and every operator is dimmer than its operands.**
  `bar*4` with the `*` at muted and `bar` at parameter-blue is readable in a
  way the current uniform field is not, and it costs nothing structural.
- **The help area moved to the bottom of the settings column** rather than the
  whole panel, so it sits under the thing it describes.
- **The empty state says what to do about it** -- *Play something. If this
  stays empty, the microphone may be blocked* -- with buttons to Setup and to
  the examples. The app has no empty state at all today; a pane that draws
  nothing looks identical whether the microphone is muted, blocked, or simply
  quiet.

## Suggested first commit

Phase 1, alone, with nothing visible changed. It is the only step that makes
every later one cheap, and it is the only step whose correctness you can check
without having to like the result.
