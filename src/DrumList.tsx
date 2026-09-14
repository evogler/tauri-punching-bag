import {
  DrumVoice,
  drumGainsText,
  drumLabel,
  drumShift,
} from "./config";
import {
  Params,
  parseNumberList,
  resolveRhythmText,
} from "./expression";
import { useHelp } from "./help";
import { accepts, invalidBorder, useFocusedValue } from "./Input";
import parser1 from "./parser1";
import parser2 from "./parser2";

export type SampleStatus = "loading" | "ok" | "error";

const DEFAULT_RHYTHM = "1:1";

export const makeDrumVoice = (path: string): DrumVoice => ({
  path,
  on: true,
  volume: 1,
  offset: 0,
  shift: 0,
  gains: { inputText: "1", val: [1] },
  rhythm: {
    inputText: DEFAULT_RHYTHM,
    val: parser2.parse(DEFAULT_RHYTHM),
    type: "parser2",
  },
});

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

const DrumRow = ({
  voice,
  status,
  params,
  onChange,
  onRemove,
}: {
  voice: DrumVoice;
  status?: SampleStatus;
  params: Params;
  onChange: (next: DrumVoice) => void;
  onRemove: () => void;
}) => {
  const [rhythmProps, setRhythmText] = useFocusedValue(voice.rhythm.inputText, {
    toString: (x) => x as string,
  });
  const [offsetProps, setOffsetText] = useFocusedValue(voice.offset);
  const [shiftProps, setShiftText] = useFocusedValue(drumShift(voice));
  const [gainsProps, setGainsText] = useFocusedValue(drumGainsText(voice), {
    toString: (x) => x as string,
  });
  const parser = voice.rhythm.type === "parser1" ? parser1 : parser2;
  // Bare parameter names, same as the grid rhythms -- the grammar does the
  // arithmetic. `resolveRustConfig` re-parses this when a parameter changes, as
  // it does the gains beside it; the offset and shift are plain numbers and are
  // not in that walk, so they stay literal on purpose.
  const parseRhythm = (text: string) =>
    parser.parse(resolveRhythmText(text, params));
  const rhythmInvalid = !accepts(() => parseRhythm(rhythmProps.value));
  const gainsInvalid = !accepts(() => parseNumberList(gainsProps.value, params));
  const failed = status === "error";
  const help = useHelp();

  return (
    <div style={{ ...rowStyle, opacity: voice.on ? 1 : 0.45 }}>
      <input
        type="checkbox"
        checked={voice.on}
        onChange={() => onChange({ ...voice, on: !voice.on })}
        title={voice.on ? "Mute this sound" : "Unmute this sound"}
        {...help("drums.on")}
      />
      <span
        title={failed ? `Could not load ${voice.path}` : voice.path}
        {...help("drums.sound")}
        style={{
          width: "7em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: failed ? "#f88" : status === "loading" ? "#aaa" : undefined,
        }}
      >
        {failed ? "⚠ " : ""}
        {drumLabel(voice.path)}
      </span>
      <input
        {...rhythmProps}
        onChange={(e) => {
          const text = e.target.value;
          setRhythmText(text);
          try {
            onChange({
              ...voice,
              rhythm: {
                ...voice.rhythm,
                val: parseRhythm(text),
                inputText: text,
              },
            });
          } catch (e) {}
        }}
        {...help("drums.rhythm")}
        style={{ flex: 1, minWidth: 0, ...invalidBorder(rhythmInvalid) }}
      />
      <input
        {...gainsProps}
        onChange={(e) => {
          const text = e.target.value;
          setGainsText(text);
          // Same contract as the rhythm field: half-typed text just doesn't
          // commit, rather than clearing what's playing. The text is kept
          // alongside the values so a parameter change can re-resolve it.
          try {
            onChange({
              ...voice,
              gains: { inputText: text, val: parseNumberList(text, params) },
            });
          } catch (e) {}
        }}
        {...help("drums.accents")}
        style={{ flex: 1, minWidth: 0, ...invalidBorder(gainsInvalid) }}
      />
      <input
        {...shiftProps}
        onChange={(e) => {
          setShiftText(e.target.value);
          const beats = parseFloat(e.target.value);
          if (isNaN(beats)) return;
          onChange({ ...voice, shift: beats });
        }}
        {...help("drums.shift")}
        style={{ width: "3.5em" }}
      />
      <input
        {...offsetProps}
        onChange={(e) => {
          setOffsetText(e.target.value);
          const ms = parseFloat(e.target.value);
          if (isNaN(ms)) return;
          onChange({ ...voice, offset: ms });
        }}
        {...help("drums.offset")}
        style={{ width: "3.5em" }}
      />
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={voice.volume}
        onChange={(e) =>
          onChange({ ...voice, volume: parseFloat(e.target.value) })
        }
        title={`Volume ${Math.round(voice.volume * 100)}%`}
        {...help("drums.volume")}
        style={{ width: "4em" }}
      />
      <button onClick={onRemove} title={`Remove ${drumLabel(voice.path)}`}>
        ✕
      </button>
    </div>
  );
};

export const DrumList = ({
  params,
  drums,
  setDrums,
  onAdd,
  status,
}: {
  params: Params;
  drums: DrumVoice[];
  setDrums: (next: DrumVoice[]) => void;
  onAdd: () => void;
  status: Record<string, SampleStatus>;
}) => {
  const help = useHelp();
  return (
  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
    <div style={{ ...rowStyle, color: "#aaa", fontSize: "0.8em" }}>
      <span style={{ width: "8.5em" }} {...help("drums.sound")}>Sound</span>
      <span style={{ flex: 1, minWidth: 0 }} {...help("drums.rhythm")}>Rhythm</span>
      <span style={{ flex: 1, minWidth: 0 }} {...help("drums.accents")}>Accents</span>
      <span style={{ width: "3.5em" }} {...help("drums.shift")}>Shift</span>
      <span style={{ width: "3.5em" }} {...help("drums.offset")}>Offset</span>
      <span style={{ width: "4em" }} {...help("drums.volume")}>Volume</span>
    </div>
    {drums.map((voice, i) => (
      <DrumRow
        params={params}
        key={i}
        voice={voice}
        status={status[voice.path]}
        onChange={(next) => setDrums(drums.map((v, j) => (j === i ? next : v)))}
        onRemove={() => setDrums(drums.filter((_, j) => j !== i))}
      />
    ))}
    {drums.some((v) => status[v.path] === "error") && (
      <div style={{ color: "#f88", fontSize: "0.8em" }}>
        {/* The full path, deliberately, where `drumLabel` shows the basename
            everywhere else. A preset from another machine points at somebody
            else's home directory, and the question a missing sample raises is
            *where it looked* -- which is the half the basename throws away. */}
        not found:{" "}
        {drums
          .filter((v) => status[v.path] === "error")
          .map((v) => v.path)
          .join(", ")}
      </div>
    )}
    <div style={rowStyle}>
      <button onClick={onAdd} {...help("drums.add")}>
        Add sound…
      </button>
      {!drums.length && (
        <span style={{ color: "#aaa", fontSize: "0.8em" }}>
          No sounds -- only the click plays.
        </span>
      )}
    </div>
  </div>
  );
};
