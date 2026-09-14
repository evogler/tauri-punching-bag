import { exprNumber } from "../config";
import { Help, useHelp } from "../help";
import { Input } from "../Input";
import { Divider, Section } from "./chrome";
import { FileInfo, PanelProps } from "./types";

// Rate and channel count are only mentioned when the loader actually had to do
// something about them, so the usual case stays short. The beat figure is the
// point of the line: it's what tells you to type 8 into Length.
const fileDescription = (info: FileInfo, bpm: number) => {
  const parts = [`${info.seconds.toFixed(3)} s`];
  if (info.sourceChannels !== 2) parts.push(`${info.sourceChannels} ch → 2`);
  if (Math.abs(info.sourceRate - info.deviceRate) > 0.5)
    parts.push(`${info.sourceRate} → ${info.deviceRate} Hz`);
  if (bpm > 0)
    parts.push(`${((info.seconds * bpm) / 60).toFixed(2)} beats at ${bpm} bpm`);
  return parts.join(" · ");
};

// Says what the segment will actually do, including the two ways it quietly
// won't: a length in beats is what makes a position in beats mean anything, and
// a backwards segment falls back to the whole file rather than being refused
// while you're still typing the other end.
const repeatDescription = (a: number, b: number, fileBeats: number) => {
  if (!(fileBeats > 0)) return "⚠ Needs a length in beats — playing the whole file";
  if (!(b > a)) return "⚠ To beat must be after From beat — playing the whole file";
  const wraps = a < 0 || b > fileBeats;
  return `${b - a} beats of the file, repeating every ${b - a}${
    wraps ? ", wrapping past its end" : ""
  }`;
};

// The ratio is a plain consequence of two numbers you have already given, so
// it's derived here rather than reported back from Rust. Above 1 is slower.
const stretchRatio = (info: FileInfo | null, fileBeats: number, bpm: number) => {
  if (!info || !(info.seconds > 0) || !(fileBeats > 0) || !(bpm > 0)) return null;
  const naturalBpm = (fileBeats * 60) / info.seconds;
  return { ratio: naturalBpm / bpm, naturalBpm };
};

// WSOLA is honest up to about a third either way; past that a drum loop starts
// to flam and sustained material warbles. Better to say so than to let it be
// discovered as "the file sounds wrong".
const STRETCH_CLEAN_LOW = 0.75;
const STRETCH_CLEAN_HIGH = 1.33;

// A file to play along with. Its own tab because it is a whole activity --
// choosing, lining up, stretching, repeating a part -- rather than one more
// thing the app plays.
export const FileTab = (p: PanelProps) => {
  const { get, set, params, chooseFile, fileInfo, fileError, setTempoFromFile, stretching } = p;
  const help = useHelp();
  return (
    <>
      <Section label="Song file">
        <Help id="filePath">
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <button onClick={chooseFile}>Choose file…</button>
            <span
              style={{
                opacity: 0.7,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                direction: "rtl",
              }}
            >
              {get("filePath") || "No file"}
            </span>
          </div>
          {fileError && <div style={{ color: "#e86" }}>{fileError}</div>}
          {fileInfo && (
            <div style={{ opacity: 0.7, fontSize: "0.9em" }}>
              {fileDescription(fileInfo, exprNumber(get("bpm")))}
            </div>
          )}
        </Help>
        <Input label="Play" _key="playFile" set={set} get={get} />
        <Input
          label="Volume"
          _key="fileVolume"
          params={params}
          set={set}
          get={get}
        />
        <Divider label="Lining up with the beat" />
        <Input
          label="Length (beats)"
          _key="fileBeats"
          params={params}
          set={set}
          get={get}
        />
        <button
          onClick={setTempoFromFile}
          disabled={!fileInfo || exprNumber(get("fileBeats")) <= 0}
          {...help("setTempoFromFile")}
        >
          Set tempo from file
        </button>
        {/* Shift before offset, everywhere they appear together: where the
            part sits musically first, then the mechanical trim. */}
        <Input
          label="Shift (beats)"
          _key="fileShift"
          params={params}
          set={set}
          get={get}
        />
        <Input
          label="Offset (ms)"
          _key="fileOffsetMs"
          params={params}
          set={set}
          get={get}
        />
        <Divider label="Following the tempo" />
        <Input label="Stretch to tempo" _key="fileStretch" set={set} get={get} />
        {get("fileStretch") &&
          (() => {
            const st = stretchRatio(
              fileInfo,
              exprNumber(get("fileBeats")),
              exprNumber(get("bpm"))
            );
            if (!st)
              return (
                <div style={{ color: "#e86", fontSize: "0.9em" }}>
                  ⚠ Needs a length in beats — playing at its own speed
                </div>
              );
            const rough =
              st.ratio < STRETCH_CLEAN_LOW || st.ratio > STRETCH_CLEAN_HIGH;
            return (
              <div
                style={{
                  fontSize: "0.9em",
                  opacity: 0.8,
                  color: rough ? "#e86" : undefined,
                }}
              >
                {st.ratio.toFixed(3)}× — {st.naturalBpm.toFixed(2)} bpm
                material at {exprNumber(get("bpm"))}
                {rough && " · past where this stays clean"}
                {stretching && " · rendering…"}
              </div>
            );
          })()}
        <Divider label="Repeat part of the file" />
        <Input label="Repeat A–B" _key="fileRepeatOn" set={set} get={get} />
        <Input
          label="From beat"
          _key="fileRepeatStart"
          params={params}
          set={set}
          get={get}
        />
        <Input
          label="To beat"
          _key="fileRepeatEnd"
          params={params}
          set={set}
          get={get}
        />
        {get("fileRepeatOn") && (
          <div style={{ opacity: 0.8, fontSize: "0.9em" }}>
            {repeatDescription(
              exprNumber(get("fileRepeatStart")),
              exprNumber(get("fileRepeatEnd")),
              exprNumber(get("fileBeats"))
            )}
          </div>
        )}
      </Section>
    </>
  );
};
