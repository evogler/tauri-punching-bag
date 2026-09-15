// Where each pane sits in the grid of cells, and every operation that moves one.
// Kept out of `config.ts` and free of React for the same reason `layout.ts` is:
// the invariant below is the whole of what makes the arrangement safe, and it
// wants to be readable -- and testable -- on its own.
//
// The invariant: **no two panes overlap, and every pane fits inside the grid.**
// `fitViews` is the one place it is enforced, and every operation here ends by
// producing a list that already satisfies it (or by answering `null`, meaning
// the operation was refused rather than applied badly). Nothing else in the app
// may write `col`/`row`/`colSpan`/`rowSpan`.
//
// See `docs/pane-layout.md` for why this is a flat grid rather than a split
// tree, and why a deleted pane leaves a hole rather than being absorbed.

import { ViewConfig, copyView, defaultViewConfig } from "./config";

// A pane's rectangle of cells. `col`/`row` are 0-based -- they are array
// arithmetic (`i % cols`) far more often than they are CSS, and CSS grid's
// 1-based lines are converted at the single point they are written. The spans
// are counts, so the smallest pane is 1x1 rather than 0x0.
export type Rect = {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
};

export const viewRect = (v: Rect): Rect => ({
  col: v.col,
  row: v.row,
  colSpan: v.colSpan,
  rowSpan: v.rowSpan,
});

const overlaps = (a: Rect, b: Rect) =>
  a.col < b.col + b.colSpan &&
  b.col < a.col + a.colSpan &&
  a.row < b.row + b.rowSpan &&
  b.row < a.row + a.rowSpan;

const insideGrid = (r: Rect, cols: number, rows: number) =>
  r.col >= 0 &&
  r.row >= 0 &&
  r.colSpan >= 1 &&
  r.rowSpan >= 1 &&
  r.col + r.colSpan <= cols &&
  r.row + r.rowSpan <= rows;

// Whether a rectangle could be a pane here: on the grid, and clear of every
// other pane. `ignore` is the pane being moved, which must not collide with
// where it currently is.
export const rectIsFree = (
  r: Rect,
  views: Rect[],
  cols: number,
  rows: number,
  ignore = -1
) =>
  insideGrid(r, cols, rows) &&
  views.every((v, i) => i === ignore || !overlaps(r, viewRect(v)));

// Reading order: left to right, then down. The order a pre-placement session's
// panes were drawn in, and the order every operation here scans in, so "the
// first empty cell" means the same thing everywhere.
export const readingOrderRect = (index: number, cols: number): Rect => ({
  col: index % cols,
  row: Math.floor(index / cols),
  colSpan: 1,
  rowSpan: 1,
});

// The first place a `colSpan` x `rowSpan` rectangle fits, scanning in reading
// order. `null` when the grid has no room for it.
export const firstFreeRect = (
  views: Rect[],
  cols: number,
  rows: number,
  colSpan = 1,
  rowSpan = 1
): Rect | null => {
  for (let row = 0; row + rowSpan <= rows; row++) {
    for (let col = 0; col + colSpan <= cols; col++) {
      const r = { col, row, colSpan, rowSpan };
      if (rectIsFree(r, views, cols, rows)) return r;
    }
  }
  return null;
};

// The panes in the order they read on screen: by top-left cell, row first.
// Used for the chained timeline, where array order would be arbitrary the
// moment a pane is swapped or added into a hole, and for deciding which pane a
// shrinking arrangement drops.
export const paneOrder = (views: Rect[]): number[] =>
  views
    .map((v, i) => i)
    .sort((a, b) => {
      const va = views[a];
      const vb = views[b];
      // Ties are impossible between two non-overlapping panes; the index
      // keeps the sort total anyway for a list that has not been fitted yet.
      return va.row - vb.row || va.col - vb.col || a - b;
    });

// Clamp a rectangle onto the grid without changing its size where it doesn't
// have to: a pane hanging off the right edge is moved left, and only shrunk
// when its span alone is wider than the grid. Size is what the owner chose;
// position is usually incidental.
const clampRect = (r: Rect, cols: number, rows: number): Rect => {
  const colSpan = Math.min(Math.max(1, Math.round(r.colSpan || 1)), cols);
  const rowSpan = Math.min(Math.max(1, Math.round(r.rowSpan || 1)), rows);
  const safe = (n: unknown) => (Number.isFinite(n as number) ? Math.round(n as number) : 0);
  return {
    colSpan,
    rowSpan,
    col: Math.min(Math.max(0, safe(r.col)), cols - colSpan),
    row: Math.min(Math.max(0, safe(r.row)), rows - rowSpan),
  };
};

// Trim a rectangle down to at most `maxCells` cells, taking from the longer
// side first, and from the *height* when they are equal: width is pixels per
// beat, which is what the display is for, where height is only how many rows
// fit. Never goes below 1x1 -- the caller decides whether a pane that cannot
// have even one cell is dropped.
const shrinkToArea = (r: Rect, maxCells: number): Rect => {
  let { colSpan, rowSpan } = r;
  while (colSpan * rowSpan > Math.max(1, maxCells) && colSpan + rowSpan > 2) {
    if (rowSpan >= colSpan) rowSpan--;
    else colSpan--;
  }
  return { ...r, colSpan, rowSpan };
};

// **The one place the invariant is enforced.** Everything that can change a
// placement -- migration, the arrangement dropdown, every button below -- ends
// here, so a layout that reaches the draw code has already been made legal.
//
// Panes are processed in the order they read on screen, so what survives a
// shrinking grid is what was nearest the top left; a pane that cannot be
// placed at all is **dropped**, which is exactly what truncating to
// `cols * rows` did before placement existed. Dropping is the last resort: a
// pane that merely doesn't fit where it was is moved, and one whose *span*
// doesn't fit is shrunk, because the expensive part of a pane is its rows,
// grids and colours rather than the cell it happened to be in.
export const fitViews = (
  views: ViewConfig[],
  cols: number,
  rows: number
): ViewConfig[] => {
  const placed: Rect[] = [];
  const out: (ViewConfig | null)[] = views.map(() => null);
  const order = paneOrder(views);
  let freeCells = cols * rows;
  order.forEach((i, position) => {
    // No pane may take so much room that a pane behind it has nowhere left to
    // go. Without this a single 2x2 pane swallows a 2x2 grid and every other
    // pane is dropped -- keeping one pane's *size* at the cost of two whole
    // panes, which is the wrong way round: a pane's rows, grids and colours
    // are the part that was typed by hand.
    const remaining = order.length - position - 1;
    const wanted = shrinkToArea(
      clampRect(viewRect(views[i]), cols, rows),
      freeCells - remaining
    );
    const rect = rectIsFree(wanted, placed, cols, rows)
      ? wanted
      : firstFreeRect(placed, cols, rows, wanted.colSpan, wanted.rowSpan) ??
        firstFreeRect(placed, cols, rows, 1, 1);
    if (!rect) return;
    placed.push(rect);
    freeCells -= rect.colSpan * rect.rowSpan;
    out[i] = { ...views[i], ...rect };
  });
  return out.filter((v): v is ViewConfig => v !== null);
};

// A new pane in the first empty cell, as a copy of the first one -- adding a
// pane is nearly always "show me this again, against another grid".
//
// `null` when there is no empty cell. The arrangement stays the only control
// over how many *cells* there are: growing the grid here would resize every
// other pane as a side effect of a button that claims to add one, and the
// dropdown is one click away.
export const addView = (
  views: ViewConfig[],
  cols: number,
  rows: number,
  // Which cell to put it in. Given by the map, where clicking an empty cell is
  // how you say *where*; omitted by the plain add button, which takes the
  // first empty cell in reading order.
  at?: Rect
): ViewConfig[] | null => {
  const rect =
    at && rectIsFree(at, views, cols, rows)
      ? at
      : firstFreeRect(views, cols, rows);
  if (!rect) return null;
  return [...views, { ...copyView(views[0] ?? defaultViewConfig()), ...rect }];
};

// What to call a pane in a list: its own name where it has one, so a named
// pane is recognisable in the swap and copy menus rather than being a number.
export const paneLabel = (views: ViewConfig[], index: number) =>
  views[index]?.name?.trim() || `Pane ${index + 1}`;

// Deleting leaves a hole. Nothing grows to absorb it, because a flat grid has
// no split tree to say *which* neighbour should -- and a heuristic that picks
// the wrong one is worse than a hole the owner closes with one click of grow.
export const removeView = (views: ViewConfig[], index: number): ViewConfig[] =>
  views.filter((_, i) => i !== index);

// Where the panel's selection has to land after a pane is removed. Everything
// about a pane -- its draw state, its layer, its canvas, the settings the panel
// is editing -- is indexed by its position in `views`, so removing one shifts
// every later pane down by one and a selection past the hole has to follow it
// or the panel silently starts editing a different pane.
export const selectionAfterRemove = (
  selected: number,
  removed: number,
  countBefore: number
) =>
  Math.max(
    0,
    selected > removed ? selected - 1 : Math.min(selected, countBefore - 2)
  );

// Grow or shrink a pane by one cell on its right or bottom edge. Refused
// (`null`) at the edge of the grid, into an occupied cell, or below 1x1 -- a
// refusal the caller shows as a disabled button rather than as an error.
export const growView = (
  views: ViewConfig[],
  index: number,
  cols: number,
  rows: number,
  axis: "col" | "row",
  delta: 1 | -1
): ViewConfig[] | null => {
  const v = views[index];
  if (!v) return null;
  const key = axis === "col" ? "colSpan" : "rowSpan";
  const next: Rect = { ...viewRect(v), [key]: viewRect(v)[key] + delta };
  if (next.colSpan < 1 || next.rowSpan < 1) return null;
  if (!rectIsFree(next, views, cols, rows, index)) return null;
  return views.map((view, i) => (i === index ? { ...view, ...next } : view));
};

// Exchange two panes' rectangles whole -- position *and* span. Swapping the
// positions alone could overlap a third pane or hang off the grid whenever the
// two differ in size; exchanging the whole rectangle is legal by construction,
// since both were legal a moment ago.
export const swapViews = (
  views: ViewConfig[],
  a: number,
  b: number
): ViewConfig[] => {
  if (a === b || !views[a] || !views[b]) return views;
  const ra = viewRect(views[a]);
  const rb = viewRect(views[b]);
  return views.map((v, i) =>
    i === a ? { ...v, ...rb } : i === b ? { ...v, ...ra } : v
  );
};

// Everything about how a pane draws, taken from another one, leaving where it
// sits alone. `copyView` does the deep copy, for the documented reason: two
// panes must never end up pointing at one `grids` array.
export const copySettings = (
  views: ViewConfig[],
  from: number,
  to: number
): ViewConfig[] => {
  if (from === to || !views[from] || !views[to]) return views;
  return views.map((v, i) =>
    i === to ? { ...copyView(views[from]), ...viewRect(v) } : v
  );
};

// Back to a fresh pane, still in its own cells.
export const resetView = (
  views: ViewConfig[],
  index: number
): ViewConfig[] =>
  views.map((v, i) =>
    i === index ? { ...defaultViewConfig(), ...viewRect(v) } : v
  );
