# Pane layout: explicit placement

The long version of what CLAUDE.md summarises under *Views*. Written when the
arrangement stopped being the only control over how many panes exist,
2026-09-14.

## What changed, and why

The canvas area was a CSS grid of `viewCols` x `viewRows`, one pane per cell, in
the order the panes happened to sit in the array. `views.length === viewCols *
viewRows` was a documented invariant, and the arrangement dropdown was the only
way to add or remove a pane. That is a clean rule and it made three ordinary
things impossible:

- **A hole.** Three panes in a 2x2 needed a fourth pane nobody wanted.
- **A pane twice the size of its neighbour.** One wide pane over two narrow ones
  is the obvious layout for "the whole phrase, and then two rulings of it", and
  there was no way to say it.
- **Reordering.** Panes were in creation order, which stops matching the screen
  as soon as you want the new one in the middle.

So a pane now says where it sits: `col`, `row`, `colSpan`, `rowSpan`, in
`ViewConfig`. The grid is still `viewCols` x `viewRows` cells; a pane occupies a
rectangle of them; a cell may hold nothing.

**The new invariant: no two panes overlap, and every pane fits inside the grid.**

- 0-based, because these are array arithmetic (`i % cols`) far more often than
  they are CSS. The 1-based grid lines CSS wants are written in exactly two
  places -- the canvas's own style in `App.tsx`, and the map in `PaneMap.tsx`.
- The spans are counts, so the smallest pane is 1x1.
- `viewCols * viewRows` is now a *ceiling* on the panes, not a count of them.

## Where the invariant is enforced

`fitViews` in `src/paneLayout.ts`, and nowhere else. Every path that can move a
pane ends there or is built from functions in that file, and each of those
returns a list that is already legal -- or returns `null`, meaning the operation
was refused rather than applied badly.

That is the whole reason the module exists and is free of React: the rule is
short enough to read in one sitting, and a second place that wrote
`col`/`row`/`colSpan`/`rowSpan` would be a second place that could break it.

`fitViews` processes panes in the order they *read* on screen -- by top-left
cell, left to right and then down -- and for each one:

1. **Clamps it onto the grid.** A pane hanging off the right edge is moved left;
   it is only shrunk when its span alone is wider than the grid. Size is what
   was chosen deliberately; position is usually incidental.
2. **Caps what it may take.** A pane may not claim so many cells that a pane
   behind it has nowhere to go. Without this one 2x2 pane swallows a 2x2 grid
   and every other pane is dropped -- keeping one pane's *size* at the cost of
   two whole panes, which is backwards: a pane's rows, grids and colours are the
   part that was typed by hand. What it gives up first is height, because width
   is pixels per beat and height is only how many rows fit.
3. **Relocates it if it collides**, to the first free rectangle of its own size,
   then to the first free cell at 1x1.
4. **Drops it** only if the grid has no free cell at all.

Dropping is the last resort and it is exactly what the old code did: truncating
to `cols * rows` threw away the panes past the end. Going from 2x2 to 1x1 still
loses three panes, because there is one cell and no argument that can conjure a
second.

## The operations

All in `paneLayout.ts`, all pure, all returning a new list.

- **Add** (`addView`) -- into the first empty cell, as a deep copy of pane 1,
  which is what adding a pane nearly always means: *show me this again, against
  another grid*. The map's `+` buttons name a cell instead.
- **Remove** (`removeView`) -- leaves a hole.
- **Grow / shrink** (`growView`) -- one cell at a time on the right or bottom
  edge. Refused at the edge of the grid, into an occupied cell, and below 1x1.
- **Swap** (`swapViews`) -- exchanges two panes' whole rectangles, position
  *and* span.
- **Copy settings** (`copySettings`) -- everything about how a pane draws, taken
  from another one, leaving the placement alone. Built on `copyView`, whose deep
  copy exists for the documented reason: two panes must never end up pointing at
  one `grids` array.
- **Reset** (`resetView`) -- a fresh pane, still in its own cells.

### Why a deleted pane leaves a hole

A tiling window manager absorbs a closed window's space into a neighbour. It can
because it holds a **split tree**: every region remembers which two regions it
was divided into, so "who inherits this space" has one answer.

A flat grid has no such structure. With a hole in the middle of a 2x2, four
panes could grow into it and nothing in the data says which should. A heuristic
-- the pane to the left, the largest neighbour, the one that fits -- is right
about half the time, and when it is wrong it has silently resized a pane you
were reading. A hole is honest, visible, and closed by one click of *Wider* or
*Taller*.

### Why swap exchanges the whole rectangle

Swapping only the two positions can overlap a third pane or hang off the grid
whenever the two panes differ in size. Exchanging the whole rectangle is legal
by construction, because both rectangles were legal a moment ago. The cost is
that a pane's shape changes when it moves, which is what it looks like on screen
anyway.

### Why add refuses instead of growing the grid

The arrangement is a deliberate statement about how the space is divided, and
every pane's size depends on it. A button labelled *Add pane* that silently made
every other pane smaller would be doing something nobody asked for, to fix
something the dropdown one line above fixes in a click. So the button is
disabled, and says why.

## What did not have to change

**The draw path.** Each pane's backing store is measured from its own DOM box by
the `ResizeObserver` in `App.tsx`, and every draw routine places things as a
fraction of its own surface. A pane spanning two cells is simply a pane with a
bigger box, so `getCanvasPositions`, the sweep, the grids, the spectrogram and
the flux are untouched. This was the bet going in and it held exactly.

`minWidth: 0, minHeight: 0` on every canvas is now load-bearing a third time. It
was there because a grid item's automatic minimum is its own aspect ratio, which
let a wide backing store push a row past the bottom of the window; it is there
now because a spanning pane's backing store is twice as wide, so its automatic
minimum would be twice the floor, and a track sized from it would push the panes
sharing its row off the screen.

## Order, for the chained timeline

`viewsSequential` divides one long timeline between the panes. It used to derive
each pane's `chainStart` from array order, which is creation order -- fine when
that was also screen order, arbitrary the moment a pane is swapped or added into
a hole. The chain now runs in `paneOrder`: by top-left cell, row first. "The
signal runs through pane 1's rows, then pane 2's" has to mean what it looks
like.

## Indexing by position

Everything about a pane is indexed by its position in `views`: its draw state,
its offscreen layer, its canvas ref, and the pane the panel is editing. Removing
a pane shifts every later one down by one, so the panel's selection has to
follow it or the panel silently starts editing a different pane.
`selectionAfterRemove` is that arithmetic, kept next to the operations and
tested with them. The draw state and the layers are safe for a different reason:
`layoutKey` carries every pane's geometry joined together, so any change in the
number of panes changes the key and the clear effect repaints everything.

## Migration

A session or preset written before placement existed has panes in reading order
and no `col`/`row`/`colSpan`/`rowSpan` at all. Restore merges the saved pane
*over* the defaults, and the defaults put every pane at the top-left cell -- so
without a migration every saved layout would come back stacked in one corner.
That is the `loopFeedback` trap, in the one place where it would be both
immediate and destructive to a hand-built layout.

`normalizeView` therefore takes a fallback rectangle and uses it whenever the
stored pane does not carry a placement, where `migrateViews` derives it as
`{col: i % viewCols, row: floor(i / viewCols), colSpan: 1, rowSpan: 1}`. All
four fields are required together: partial placement is not a shape anything
ever wrote, and mixing a saved `col` with a derived `row` would put a pane
somewhere nobody asked for.

Two further rules follow from the same question:

- **A pre-placement config is still padded to `cols * rows` panes**, because
  that is what it had. A config written since is *not*: an empty cell is a
  layout, not a gap to fill.
- **Everything then goes through `fitViews`**, which is what makes a
  hand-edited, corrupt or foreign layout safe rather than trusted.

A 1x1-everywhere layout is position-for-position what the old code drew: CSS
grid auto-flow places items in reading order, so explicit placement in reading
order is the same placement.

## Rejected: a recursive split tree

A real tiling window manager stores a **BSP tree** -- each node a horizontal or
vertical split with a ratio, each leaf a pane. It is the right structure for
this problem in the abstract, and it buys two things this design does not have:

- **Arbitrary ratios.** A 70/30 split instead of the 2:1 that a 3-cell grid
  allows.
- **Automatic fill.** Closing a pane is unambiguous: its sibling takes the
  space.

What it costs is the schema. The tree is recursive, and **presets and the saved
session have to carry it** -- so every rule in CLAUDE.md's config section applies
to a nested, variable-depth structure rather than to four integers:
`normalizeView` has to validate a tree written by an older build, migration has
to turn a flat list into one, and the hash that decides whether two presets are
the same settings has to canonicalise it. A pane list also stops being a list:
"pane 3" needs a stable identity that survives the tree being rebalanced, which
is a second concept the config does not have today.

Against that, the flat grid gives coarse ratios and one manual click after a
delete. At `MAX_VIEW_SIDE` of 4 the ratios available are already 1:1, 2:1, 3:1
and 1:3 across two axes, which covers what this display is actually for. The
tree is the right answer to a question nobody has asked yet, and it can be added
later on top of a schema that at least stores placement explicitly.

## Rejected: inferring the layout from the pane order

Keeping `views` as a flat list and deriving placement from a per-pane "weight"
(pane 1 takes two columns, pane 2 takes one) avoids new keys entirely. It fails
on the hole: a weight can say how *much* space a pane takes and never where the
empty space is, so "three panes and a gap at the bottom right" is unsayable --
which is the whole feature.

## Not built

**Drag to resize, and drag to reorder.** Deliberately out of scope. Every
operation here is one click with a definite answer, which is also what makes the
refusals legible: a grow that would collide is a disabled button rather than a
drag that snaps back with no explanation. A drag UI is worth having on top of
this and needs none of it to change.

**Per-pane aspect or pixel sizing.** The tracks stay `1fr`. A pane's size is how
many cells it holds, and nothing else.
