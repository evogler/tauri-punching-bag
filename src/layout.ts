// Where a beat lands on the canvas. Kept free of React and config plumbing so
// the geometry can be reasoned about (and tested) on its own.

export type Layout = {
  beatsPerRow: number[];
  // Cumulative row starts, one longer than beatsPerRow.
  rowStarts: number[];
  beatsPerWindow: number;
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
// because the loop repeats, a margin wider than the loop shows the same beat
// again once per extra loop it spans -- a 1-beat row with margins of 2 draws
// that beat five times across the width.
export const getCanvasPositions = (
  layout: Layout,
  beat: number
): Position[] => {
  const {
    beatsPerRow,
    rowStarts,
    beatsPerWindow,
    pixelsPerBeat,
    marginLeft,
    marginRight,
  } = layout;

  const positions: Position[] = [];
  // Nothing sensible to draw, and the modulo below would divide by zero.
  if (!(beatsPerWindow > 0)) return positions;

  const b = ((beat % beatsPerWindow) + beatsPerWindow) % beatsPerWindow;

  for (let row = 0; row < beatsPerRow.length; row++) {
    const start = rowStarts[row];
    const length = beatsPerRow[row];
    // `d` is the beat's distance from the row's start. Sliding it by whole
    // loops gives the repeats; keep the ones inside the row's drawn span.
    const firstLoop = Math.ceil((start - marginLeft - b) / beatsPerWindow);
    const lastLoop = Math.floor(
      (start + length + marginRight - b) / beatsPerWindow
    );
    for (let loop = firstLoop; loop <= lastLoop; loop++) {
      const d = b + loop * beatsPerWindow - start;
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
