import { useState } from "react";
import { NumberExpr, Rhythm, ViewConfig, VisualGrid } from "./config";
import { accepts, invalidBorder } from "./Input";
import {
  MAX_LIST_LENGTH,
  Params,
  evaluate,
  formatNumberList,
  parseNumberList,
  resolveRhythmText,
} from "./expression";
import parser2 from "./parser2";

// One row per note you are aiming at, with the target and the point exactly out
// of phase with it marked. Every field this writes is an ordinary per-view
// setting, so this is a *generator* rather than a mode: once applied there is
// nothing holding the pane in this shape and nothing to fight a hand edit.
// Same idiom as `set tempo from file` and the calibration's `apply` -- compute
// something worth having, write it into the fields that already exist.
//
// It writes expressions rather than the numbers they come to, so typing
// `bar/n` here leaves a pane that follows `n` afterwards. That is the whole
// reason it is worth having a button: the configuration is a good one and
// nobody would arrive at it from six separate fields.

// From GRID_COLORS, but named for what they mean here: where the note goes,
// and how far off it is possible to be.
const TARGET_COLOR = "#33cc66";
const ANTIPODE_COLOR = "#ff5533";

// A quarter of a pulse of lead-in, which puts the target a quarter of the way
// across the row and the antipode three quarters -- symmetric, with room
// before the note for a sustain that ran over. Named for `marginLeft`, which
// is what it writes.
const DEFAULT_LEAD = "1/4";

export type Shape = {
  divisionText: string;
  countText: string;
  leadText: string;
};

// Float noise in a generated expression reads as a bug, and these are numbers
// the user is going to look at.
const num = (x: number) => String(+x.toPrecision(12));

// True when the whole text is one bracketed group, so wrapping it again would
// only nest a group inside itself.
const isBracketed = (text: string) => {
  if (!text.startsWith("[")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[" || text[i] === "(") depth++;
    else if (text[i] === "]" || text[i] === ")") {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
};

// `x` repeats a *group*, so a bare list has to be bracketed before it can be
// repeated -- `[.6,.4] x 8`. A list parameter already stands where a group
// would, and bracketing it is still correct, so this only has to avoid
// double-wrapping text that is a group already.
const asGroup = (text: string, isList: boolean) =>
  isList && !isBracketed(text) ? `[${text}]` : text;

const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

// Whether the character at `i` continues a name rather than starting a token.
// A digit run does not make one -- `0.25x16` splits, which is exactly how
// `formatNumberList` writes a repeat -- so what matters is whether the run of
// word characters ending just before `i` begins with a letter.
const continuesName = (text: string, i: number) => {
  let j = i;
  while (j > 0 && isWord(text[j - 1])) j--;
  return j < i && /[A-Za-z_]/.test(text[j]);
};

// Recovers the two halves of `bar/n x n`, so re-opening the form shows the
// expressions that are in the field rather than the numbers they happen to
// evaluate to. `x` is reserved and `0.25x16` carries no spaces, so the
// separator is an `x` at depth zero that neither continues an identifier nor
// starts one -- the same rule `tokenize` follows.
export const splitRepeat = (text: string): [string, string] | null => {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (depth === 0 && (c === "x" || c === "X")) {
      const after = text[i + 1];
      if (!continuesName(text, i) && (!isWord(after) || /\d/.test(after))) {
        const left = text.slice(0, i).trim();
        const right = text.slice(i + 1).trim();
        if (left && right) return [left, right];
      }
    }
  }
  return null;
};

const rhythm = (text: string, params: Params): Rhythm => ({
  inputText: text,
  val: parser2.parse(resolveRhythmText(text, params)),
  type: "parser2",
});

// Everything the shape writes, as a patch rather than an applied change: the
// caller puts all of it into one update, and a pure function is what lets the
// form show the result before committing to it.
//
// Throws rather than returning something partial, like everything else in
// expression.ts -- the form uses the throw to decide whether `apply` is live.
export const rowPerNotePatch = (
  { divisionText, countText, leadText }: Shape,
  params: Params
): Partial<ViewConfig> => {
  const division = divisionText.trim();
  const count = countText.trim();
  const lead = leadText.trim();

  const pulses = parseNumberList(division, params);
  if (!pulses.length) throw new Error("no division");
  if (pulses.some((d) => !(d > 0))) throw new Error("a pulse has to be positive");

  const repeats = Math.round(evaluate(count, params));
  if (!(repeats >= 1)) throw new Error("at least one");
  if (repeats * pulses.length > MAX_LIST_LENGTH)
    throw new Error(`more than ${MAX_LIST_LENGTH} rows`);

  const leadFraction = evaluate(lead, params);
  if (!(leadFraction >= 0 && leadFraction < 1))
    throw new Error("lead is a fraction of a pulse");

  const isList = pulses.length > 1;
  const cycle = pulses.reduce((a, b) => a + b, 0);
  // One number serves the whole pane, so an uneven division gets the mean
  // pulse. The rows then differ in length, which is what a swung setting looks
  // like and is the point of it.
  const margin = (cycle / pulses.length) * leadFraction;

  const rows: number[] = [];
  for (let i = 0; i < repeats; i++) rows.push(...pulses);

  // Equal and opposite: the drawn width is `max(row) + left + right`, so this
  // rotates the row window earlier without widening it. Every instant still
  // appears exactly once -- no duplication, no gap -- with the target sitting
  // `lead` of the way across instead of on the left edge.
  const marginText = isList ? num(margin) : `(${division}) * (${lead})`;

  // Half way between each note and the next. Written as the gaps *between*
  // those midpoints plus a shift onto the first, because a rhythm is spans
  // measured from its own start: the last gap has to close the cycle rather
  // than stop short of it. Degenerates to the even case exactly.
  const mids: number[] = [];
  let at = 0;
  for (const d of pulses) {
    mids.push(at + d / 2);
    at += d;
  }
  const gaps = mids.map(
    (m, i) => (i + 1 < mids.length ? mids[i + 1] : mids[0] + cycle) - m
  );

  const group = asGroup(division, isList);
  const targetText = isList ? `${group}:${num(cycle)}` : division;
  const antipodeText = isList
    ? `[${gaps.map(num).join(",")}]:${num(cycle)}`
    : division;
  const antipodeShift: NumberExpr = isList
    ? { inputText: num(mids[0]), val: mids[0] }
    : { inputText: `(${division}) / 2`, val: mids[0] };

  // Target first: grids are drawn bottom-of-the-list first, so where the two
  // land on the same beat the target is the one you see.
  const grids: VisualGrid[] = [
    {
      color: TARGET_COLOR,
      alpha: 1,
      subdivisions: rhythm(targetText, params),
    },
    {
      color: ANTIPODE_COLOR,
      alpha: 1,
      subdivisions: rhythm(antipodeText, params),
      shift: antipodeShift,
    },
  ];

  return {
    beatsPerRow: { inputText: `${group} x ${repeats}`, val: rows },
    marginLeft: { inputText: marginText, val: margin },
    marginRight: {
      inputText: isList ? num(-margin) : `-(${marginText})`,
      val: -margin,
    },
    grids,
  };
};

// Seeded from the pane rather than from constants, so the form opens describing
// what is already on screen and `apply` is a refinement rather than a reset.
const seed = (view: ViewConfig): Shape => {
  const split = splitRepeat(view.beatsPerRow.inputText);
  const rows = view.beatsPerRow.val;
  return {
    divisionText: split
      ? split[0]
      : rows.length
      ? formatNumberList([rows[0]])
      : "1/4",
    countText: split ? split[1] : String(Math.max(1, rows.length)),
    leadText: DEFAULT_LEAD,
  };
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
};

const Field = ({
  label,
  value,
  invalid,
  title,
  onChange,
}: {
  label: string;
  value: string;
  invalid: boolean;
  title: string;
  onChange: (text: string) => void;
}) => (
  <div style={rowStyle}>
    <label>{label}</label>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={title}
      style={{ width: "8em", ...invalidBorder(invalid) }}
    />
  </div>
);

export const RowPerNote = ({
  view,
  params,
  apply,
}: {
  view: ViewConfig;
  params: Params;
  apply: (patch: Partial<ViewConfig>) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [shape, setShape] = useState(() => seed(view));

  let patch: Partial<ViewConfig> | null = null;
  let error = "";
  try {
    patch = rowPerNotePatch(shape, params);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const rows = patch?.beatsPerRow?.val ?? [];
  const beats = rows.reduce((a, b) => a + b, 0);

  if (!open)
    return (
      <div style={rowStyle}>
        <button
          onClick={() => {
            // Re-seeded on open rather than only on mount, so editing the rows
            // by hand and then coming back here starts from what is there.
            setShape(seed(view));
            setOpen(true);
          }}
          title="rows, grids and margins for watching one note per row"
        >
          one row per note…
        </button>
      </div>
    );

  const field = (key: keyof Shape) => (text: string) =>
    setShape((s) => ({ ...s, [key]: text }));
  // Only the field that is actually wrong should go red, so each is checked on
  // its own as well as through the patch.
  const divisionBad = !accepts(() =>
    parseNumberList(shape.divisionText.trim(), params)
  );
  const countBad = !accepts(() => evaluate(shape.countText.trim(), params));
  const leadBad = !accepts(() => evaluate(shape.leadText.trim(), params));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <Field
        label="division"
        value={shape.divisionText}
        invalid={divisionBad}
        title={
          'how long one note is, in beats: "1/4" for 16ths, "bar/n", or a ' +
          'swing pair like ".6,.4"'
        }
        onChange={field("divisionText")}
      />
      <Field
        label="how many"
        value={shape.countText}
        invalid={countBad}
        title="how many of them to show, one per row"
        onChange={field("countText")}
      />
      <Field
        label="lead-in"
        value={shape.leadText}
        invalid={leadBad}
        title="how far into the row the target sits, as a fraction of a pulse"
        onChange={field("leadText")}
      />
      <div style={rowStyle}>
        <button
          disabled={!patch}
          onClick={() => {
            if (patch) apply(patch);
            setOpen(false);
          }}
          title="replaces this pane's rows, margins and grids"
        >
          apply
        </button>
        <button onClick={() => setOpen(false)}>cancel</button>
        <span style={{ color: error ? "#fbb" : "#aaa", fontSize: "0.8em" }}>
          {error || `${rows.length} rows, ${num(beats)} beats`}
        </span>
      </div>
    </div>
  );
};
