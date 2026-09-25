import { ui } from "./theme";

// A rhythm field, with the hits it produces drawn under the text inside the
// same box.
//
// **The text is the notation and the strip is the picture.** `8:4` and
// `[.6,.4]x2` are precise and neither is legible at a glance, so until now the
// only way to see what a rhythm did was to play it and watch the pane. This is
// the rhythm field's version of what `Resolved` does for a number: the field
// shows what you wrote, and the thing beside it shows what it means.
//
// **It draws what sounds, which is not the same as what the rhythm contains.**
// A drum grid writes a note for *every column* and says which ones are silent
// in `chances` -- an unchecked cell is a chance of 0, because parser2 has no
// rests and writing the gaps between hits instead would move the first hit to
// time 0 wherever it was drawn. So a strip reading the rhythm alone drew a
// grid's silent columns as hits: it claimed to show what you would hear and
// showed the opposite. `chances` and `gains` are read beside the notes, both
// indexed by hit count with the wrap the audio thread uses.
//
// **A rest is still drawn, because a rest still sounds.** The grammar parses
// `r`, the Rust `Note` struct carries only `time`, and serde drops the flag --
// the same fate as `sounds`. Drawing it as a gap would make the preview
// disagree with the sound, which is the very thing above. See *Known issues*.

export type ParsedRhythm = {
  notes: { time: number }[];
  start: number;
  end: number;
};

const HEIGHT = 13;
const DOT = 5;

/// Both lists are indexed by *hit count* and wrap, never by position in the
/// bar -- so a list that does not divide the rhythm drifts against it, which
/// is deliberate and is what the audio thread does with `rem_euclid`. Empty
/// means no modulation at all.
const at = (list: number[] | undefined, i: number) =>
  list && list.length ? list[i % list.length] : 1;

export const RhythmStrip = ({
  rhythm,
  chances,
  gains,
  stale,
}: {
  rhythm?: ParsedRhythm;
  /** Per-hit probabilities. A 0 does not sound, so it is not drawn. */
  chances?: number[];
  /** Per-hit volumes, drawn as the size of the dot. */
  gains?: number[];
  /** The text no longer parses, so this is the last rhythm that did. */
  stale?: boolean;
}) => {
  // A parser1 rhythm is a flat array of times rather than this shape, and a
  // `val` sanitized away by a bad session could be anything at all. Neither
  // is worth a crash: the strip just draws its baseline and nothing on it.
  const shaped = !!rhythm && Array.isArray(rhythm.notes);
  const span = shaped ? rhythm!.end - rhythm!.start : 0;
  // A non-positive span is a syntax error the grammar already rejects, and a
  // division by it here would put every dot at NaN%.
  const usable = shaped && Number.isFinite(span) && span > 0;
  // Past about four dozen the dots start touching, so they become ticks rather
  // than growing into one slab. Honest either way: a dense rhythm looks dense.
  const dense = usable && rhythm!.notes.length > 48;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        height: `${HEIGHT}px`,
        marginTop: "2px",
        // Dimmed when the text has stopped parsing: what is drawn is still
        // playing, but it is not what is written above it.
        opacity: stale ? 0.4 : 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${HEIGHT / 2}px`,
          height: "1px",
          backgroundColor: ui.line.divider,
        }}
      />
      {usable &&
        rhythm!.notes.map((note, i) => {
          const where = ((note.time - rhythm!.start) / span) * 100;
          if (!Number.isFinite(where)) return null;
          const chance = at(chances, i);
          const gain = at(gains, i);
          // Neither sounds, so neither is drawn. A gain of 0 still costs the
          // audio thread a silent sample where a chance of 0 costs nothing,
          // but from here they are the same thing: you hear nothing.
          if (!(chance > 0) || !(gain > 0)) return null;
          // A hit that only sometimes sounds is drawn fainter, floored so that
          // a one-in-ten hit is still visible rather than effectively absent.
          const opacity = Math.max(0.3, Math.min(1, chance));
          // Loudness as size, over a deliberately narrow range: this says
          // "these two are not the same" without pretending to be a meter.
          const w = dense
            ? 2
            : Math.round(DOT * Math.max(0.6, Math.min(1.3, Math.sqrt(gain))));
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                // The first and last dots would otherwise hang half outside
                // the box; the strip is inset instead of the dots being
                // clamped, so the spacing between them stays true.
                left: `calc(${Math.max(0, Math.min(100, where))}% - ${w / 2}px)`,
                top: `${(HEIGHT - w) / 2}px`,
                width: `${w}px`,
                height: `${w}px`,
                borderRadius: dense ? "1px" : "50%",
                backgroundColor: ui.accent,
                opacity,
              }}
            />
          );
        })}
    </div>
  );
};

/// The field and its strip as one recessed box, so the picture reads as part
/// of the thing that produced it rather than as a separate widget underneath.
/// The `input` gives up its own chrome to the box around it -- inline styles
/// win over `index.css`, which is the documented way to opt out.
export const RhythmField = ({
  inputProps,
  rhythm,
  chances,
  gains,
  invalid,
  readOnly,
  style,
}: {
  /** Everything to spread on the input: the focused value, onChange, help. */
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
  rhythm?: ParsedRhythm;
  chances?: number[];
  gains?: number[];
  invalid?: boolean;
  /** A rhythm a grid owns: shown, not editable. */
  readOnly?: boolean;
  /** Sizing from the caller -- a width, or flex in a lane. */
  style?: React.CSSProperties;
}) => (
  <div
    style={{
      backgroundColor: readOnly ? ui.surface.inset : ui.surface.field,
      border: `1px solid ${invalid ? ui.error : ui.line.field}`,
      borderRadius: "5px",
      padding: "2px 6px 3px",
      boxSizing: "border-box",
      minWidth: 0,
      ...style,
    }}
  >
    <input
      {...inputProps}
      readOnly={readOnly}
      style={{
        display: "block",
        width: "100%",
        border: "none",
        background: "transparent",
        padding: 0,
        borderRadius: 0,
        outline: "none",
        color: readOnly ? ui.text.muted : undefined,
        cursor: readOnly ? "default" : undefined,
        ...inputProps.style,
      }}
    />
    <RhythmStrip
      rhythm={rhythm}
      chances={chances}
      gains={gains}
      stale={invalid}
    />
  </div>
);
