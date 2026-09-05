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
};

export type Position = {
  x: number;
  row: number;
  // Outside the row's own beats, so it's a repeat of another part of the loop.
  isMargin: boolean;
};

// A beat repeats once per loop that the margins span, so this only bites on
// absurd settings (a margin hundreds of times the loop length); it keeps those
// from stalling the draw loop.
const MAX_POSITIONS_PER_BEAT = 512;

// Every place on the canvas a given beat shows up. A row is drawn as its own
// beats plus `marginLeft` beats of lead-in and `marginRight` of lead-out, and
// because the timeline repeats, a margin wider than it shows the same beat
// again once per extra cycle it spans -- a 1-beat row with margins of 2 draws
// that beat five times across the width. Chained, the repeat is a whole cycle
// of every pane, so a pane's margins show its neighbours' beats.
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
    // `d` is the beat's distance from the row's start. Sliding it by whole
    // loops gives the repeats; keep the ones inside the row's drawn span.
    const firstLoop = Math.ceil((start - marginLeft - b) / cycleBeats);
    const lastLoop = Math.floor(
      (start + length + marginRight - b) / cycleBeats
    );
    for (let loop = firstLoop; loop <= lastLoop; loop++) {
      const d = b + loop * cycleBeats - start;
      positions.push({
        x: (d + marginLeft) * pixelsPerBeat,
        row,
        isMargin: d < 0 || d >= length,
      });
      if (positions.length >= MAX_POSITIONS_PER_BEAT) return positions;
    }
  }
  return positions;
};
