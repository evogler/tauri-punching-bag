import { DrumVoice, drumGains, drumLabel, drumShift } from "./config";
import { formatNumberList, parseNumberList, useFocusedValue } from "./Input";
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
  gains: [1],
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
  onChange,
  onRemove,
}: {
  voice: DrumVoice;
  status?: SampleStatus;
  onChange: (next: DrumVoice) => void;
  onRemove: () => void;
}) => {
  const [rhythmProps, setRhythmText] = useFocusedValue(voice.rhythm.inputText, {
    toString: (x) => x as string,
  });
  const [offsetProps, setOffsetText] = useFocusedValue(voice.offset);
  const [shiftProps, setShiftText] = useFocusedValue(drumShift(voice));
  const [gainsProps, setGainsText] = useFocusedValue(drumGains(voice), {
    toString: (val) => formatNumberList(val as number[]),
  });
  const parser = voice.rhythm.type === "parser1" ? parser1 : parser2;
  const failed = status === "error";

  return (
    <div style={{ ...rowStyle, opacity: voice.on ? 1 : 0.45 }}>
      <input
        type="checkbox"
        checked={voice.on}
        onChange={() => onChange({ ...voice, on: !voice.on })}
        title={voice.on ? "Mute this sound" : "Unmute this sound"}
      />
      <span
        title={failed ? `Could not load ${voice.path}` : voice.path}
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
                val: parser.parse(text),
                inputText: text,
              },
            });
          } catch (e) {}
        }}
        title="Rhythm for this sound"
        style={{ flex: 1, minWidth: 0 }}
      />
      <input
        {...gainsProps}
        onChange={(e) => {
          const text = e.target.value;
          setGainsText(text);
          // Same contract as the rhythm field: half-typed text just doesn't
          // commit, rather than clearing what's playing.
          try {
            onChange({ ...voice, gains: parseNumberList(text) });
          } catch (e) {}
        }}
        title="Gain per hit, cycled -- e.g. 1,0.5 or 1,0.6x3. Multiplies the volume slider"
        style={{ flex: 1, minWidth: 0 }}
      />
      <input
        {...shiftProps}
        onChange={(e) => {
          setShiftText(e.target.value);
          const beats = parseFloat(e.target.value);
          if (isNaN(beats)) return;
          onChange({ ...voice, shift: beats });
        }}
        title="Push this part this many beats later in the cycle, so it doesn't start on one"
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
        title="Start this many ms early, so the attack lands on the beat"
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
        style={{ width: "4em" }}
      />
      <button onClick={onRemove} title={`Remove ${drumLabel(voice.path)}`}>
        ✕
      </button>
    </div>
  );
};

export const DrumList = ({
  drums,
  setDrums,
  onAdd,
  status,
}: {
  drums: DrumVoice[];
  setDrums: (next: DrumVoice[]) => void;
  onAdd: () => void;
  status: Record<string, SampleStatus>;
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
    <div style={{ ...rowStyle, color: "#aaa", fontSize: "0.8em" }}>
      <span style={{ width: "8.5em" }}>sound</span>
      <span style={{ flex: 1, minWidth: 0 }}>rhythm</span>
      <span style={{ flex: 1, minWidth: 0 }}>gain</span>
      <span style={{ width: "3.5em" }}>beats</span>
      <span style={{ width: "3.5em" }}>ms</span>
      <span style={{ width: "4em" }}>vol</span>
    </div>
    {drums.map((voice, i) => (
      <DrumRow
        key={i}
        voice={voice}
        status={status[voice.path]}
        onChange={(next) => setDrums(drums.map((v, j) => (j === i ? next : v)))}
        onRemove={() => setDrums(drums.filter((_, j) => j !== i))}
      />
    ))}
    <div style={rowStyle}>
      <button onClick={onAdd} title="Pick an audio file to use as a drum sound">
        + ADD SAMPLE
      </button>
      {!drums.length && (
        <span style={{ color: "#aaa", fontSize: "0.8em" }}>
          No sounds -- only the click plays.
        </span>
      )}
    </div>
  </div>
);
