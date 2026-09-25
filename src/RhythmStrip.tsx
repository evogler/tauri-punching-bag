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
// **Every note is drawn, rests included, because every note sounds.** The
// grammar parses `r` and the Rust `Note` struct carries only `time`, so serde
// drops the flag and the note plays -- the same fate as `sounds`. Drawing a
// rest as a gap would make the preview disagree with the sound, which is worse
// than not showing rests at all. See *Known issues*.

export type ParsedRhythm = {
  notes: { time: number }[];
  start: number;
  end: number;
};

const HEIGHT = 13;

export const RhythmStrip = ({
  rhythm,
  stale,
}: {
  rhythm?: ParsedRhythm;
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
          const at = ((note.time - rhythm!.start) / span) * 100;
          if (!Number.isFinite(at)) return null;
          const w = dense ? 2 : 5;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                // The first and last dots would otherwise hang half outside
                // the box; the strip is inset instead of the dots being
                // clamped, so the spacing between them stays true.
                left: `calc(${Math.max(0, Math.min(100, at))}% - ${w / 2}px)`,
                top: `${(HEIGHT - w) / 2}px`,
                width: `${w}px`,
                height: `${w}px`,
                borderRadius: dense ? "1px" : "50%",
                backgroundColor: ui.accent,
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
  invalid,
  readOnly,
  style,
}: {
  /** Everything to spread on the input: the focused value, onChange, help. */
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
  rhythm?: ParsedRhythm;
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
    <RhythmStrip rhythm={rhythm} stale={invalid} />
  </div>
);
