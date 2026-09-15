// Where a beat lands on the canvas. Kept free of React and config plumbing so
// the geometry can be reasoned about (and tested) on its own.

export type Layout = {
  beatsPerRow: number[];
  // Cumulative row starts, one longer than beatsPerRow.
  rowStarts: number[];
  beatsPerWindow: number;
  // The timeline the display wraps on, and where this pane sits in it. Drawn
  // simultaneously, every pane covers the same beats, so `cycleBeats` is the
  // pane's own `beatsPerWindow` and `chainStart` is 0. Chained, the panes
  // divide one longer timeline between them and a beat belongs to exactly one
  // of them -- the others simply get no positions for it.
  cycleBeats: number;
  chainStart: number;
  pixelsPerBeat: number;
  marginLeft: number;
  marginRight: number;
  // The rows wrapped into several strips side by side, newspaper fashion: fill
  // a strip top to bottom, then start the next one. One source of truth for the
  // pane -- one `beatsPerRow`, one set of grids, one set of margins -- drawn
  // narrower so more of it fits. 1 and `beatsPerRow.length` is the pane exactly
  // as it was before columns existed.
  rowColumns: number;
  rowsPerColumn: number;
  // One strip's width in surface pixels, and a *whole* number of them: the
  // eraser works in whole pixel columns, so a strip boundary at a fraction
  // would leave one column shared between two strips, each erasing the other's
  // edge and neither coming back to repaint it. The few pixels lost to the
  // rounding sit unused at the pane's right edge.
  columnWidth: number;
};

export type Position = {
  x: number;
  // The row in the pane's own list -- what `rowColorPattern` is indexed by, and
  // unchanged by how the rows are wrapped onto the screen.
  row: number;
  // Where that row is *drawn*: the strip it wrapped into, and how far down that
  // strip it sits. With one column these are 0 and `row`.
  column: number;
  rowInColumn: number;
  // Outside the row's own beats, so it's a repeat of another part of the loop.
  isMargin: boolean;
};

// A beat repeats once per loop that the margins span, so this only bites on
// absurd settings (a margin hundreds of times the loop length); it keeps those
// from stalling the draw loop.
const MAX_POSITIONS_PER_BEAT = 512;

// How the rows divide between the strips, and how wide a strip is. Derived
// rather than stored, so a row count that changes under a fixed `rowColumns`
// re-divides rather than going stale.
//
// The rows per strip are what is actually fixed: asking for more columns than
// can be filled collapses to however many the rows reach (4 rows in 3 columns
// is two strips of two, not two strips and an empty third). An uneven split
// fills the earlier strips and leaves the gap at the bottom of the last one --
// 5 rows in 2 columns is 3 then 2, with the last strip's bottom third empty.
export const rowColumnLayout = (
  rowCount: number,
  requested: number,
  paneWidth: number
): { rowColumns: number; rowsPerColumn: number; columnWidth: number } => {
  const rows = Math.max(1, rowCount);
  const want = Math.max(1, Math.min(Math.round(requested) || 1, rows));
  const rowsPerColumn = Math.ceil(rows / want);
  const rowColumns = Math.ceil(rows / rowsPerColumn);
  return {
    rowColumns,
    rowsPerColumn,
    columnWidth: Math.max(1, Math.floor(paneWidth / rowColumns)),
  };
};

// Where a row is drawn: which strip it wrapped into, how far down that strip it
// sits, and the strip's horizontal extent. This is the single definition of a
// row's *horizontal* extent, the counterpart to `rowBox`'s vertical one -- the
// eraser, the waveform, the grids, the onset ticks and the spectrogram all clip
// to what it says, and they must agree exactly or the sweep erases something it
// never comes back to redraw.
export const rowPlacement = (
  layout: Layout,
  row: number
): { column: number; rowInColumn: number; left: number; width: number } => {
  const per = Math.max(1, layout.rowsPerColumn);
  const column = Math.floor(row / per);
  return {
    column,
    rowInColumn: row - column * per,
    left: column * layout.columnWidth,
    width: layout.columnWidth,
  };
};

// Every place on the canvas a given beat shows up. A row is drawn as its own
// beats plus `marginLeft` beats of lead-in and `marginRight` of lead-out, and
// because the timeline repeats, a margin wider than it shows the same beat
// again once per extra cycle it spans -- a 1-beat row with margins of 2 draws
// that beat five times across the width. Chained, the repeat is a whole cycle
// of every pane, so a pane's margins show its neighbours' beats. Wrapped into
// columns, the row's x is offset by the strip it landed in; nothing else about
// the arithmetic changes, which is what keeps this the one answer to where a
// beat is.
export const getCanvasPositions = (
  layout: Layout,
  beat: number
): Position[] => {
  const {
    beatsPerRow,
    rowStarts,
    cycleBeats,
    chainStart,
    pixelsPerBeat,
    marginLeft,
    marginRight,
  } = layout;

  const positions: Position[] = [];
  // Nothing sensible to draw, and the modulo below would divide by zero.
  if (!(cycleBeats > 0)) return positions;

  // Where the beat falls in the timeline, measured from this pane's start. A
  // chained pane's slice is only part of that timeline, so `b` can land outside
  // every row's drawn span -- which is how a beat that belongs to another pane
  // ends up drawing nothing here.
  const b = ((beat % cycleBeats) + cycleBeats) % cycleBeats - chainStart;

  for (let row = 0; row < beatsPerRow.length; row++) {
    const start = rowStarts[row];
    const length = beatsPerRow[row];
    const { column, rowInColumn, left } = rowPlacement(layout, row);
    // `d` is the beat's distance from the row's start. Sliding it by whole
    // loops gives the repeats; keep the ones inside the row's drawn span.
    const firstLoop = Math.ceil((start - marginLeft - b) / cycleBeats);
    const lastLoop = Math.floor(
      (start + length + marginRight - b) / cycleBeats
    );
    for (let loop = firstLoop; loop <= lastLoop; loop++) {
      const d = b + loop * cycleBeats - start;
      positions.push({
        x: left + (d + marginLeft) * pixelsPerBeat,
        row,
        column,
        rowInColumn,
        isMargin: d < 0 || d >= length,
      });
      if (positions.length >= MAX_POSITIONS_PER_BEAT) return positions;
    }
  }
  return positions;
};
