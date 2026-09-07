import {
  DrumVoice,
  Section,
  cycleBeatsOf,
  drumLabel,
  sectionBeats,
} from "./config";
import { Params, evaluate } from "./expression";
import { accepts, invalidBorder, useFocusedValue } from "./Input";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

export const makeSection = (drums: DrumVoice[]): Section => ({
  on: true,
  beats: { inputText: "4", val: 4 },
  click: true,
  // A new section starts with everything sounding, which is the section you
  // most often want; a count-off or a pause is then a matter of turning things
  // off rather than hunting for what to turn on.
  drums: drums.map((_, i) => i),
});

const SectionRow = ({
  section,
  drums,
  params,
  from,
  onChange,
  onRemove,
}: {
  section: Section;
  drums: DrumVoice[];
  params: Params;
  /** Where this section starts in the cycle, for the readout. */
  from: number;
  onChange: (next: Section) => void;
  onRemove: () => void;
}) => {
  const [beatsProps, setBeatsText] = useFocusedValue(section.beats.inputText, {
    toString: (x) => x as string,
  });
  const parse = (text: string) => {
    const n = evaluate(text, params);
    if (!(n > 0) || !Number.isFinite(n)) throw new Error("out of range");
    return n;
  };
  const invalid = !accepts(() => parse(beatsProps.value));
  const toggleDrum = (i: number) =>
    onChange({
      ...section,
      drums: section.drums.includes(i)
        ? section.drums.filter((d) => d !== i)
        : [...section.drums, i],
    });

  return (
    <div style={{ ...rowStyle, opacity: section.on ? 1 : 0.45 }}>
      <input
        type="checkbox"
        checked={section.on}
        onChange={() => onChange({ ...section, on: !section.on })}
        title={section.on ? "Skip this section" : "Use this section"}
      />
      <span
        style={{ width: "4.5em", color: "#aaa", fontSize: "0.8em" }}
        title="Where this section starts in the cycle"
      >
        {section.on ? `@${Number(from.toPrecision(6))}` : "--"}
      </span>
      <input
        {...beatsProps}
        onChange={(e) => {
          const text = e.target.value;
          setBeatsText(text);
          try {
            onChange({ ...section, beats: { inputText: text, val: parse(text) } });
          } catch (e) {}
        }}
        title={'How long, in beats. Arithmetic and parameters allowed: "bar*16"'}
        style={{ width: "5em", ...invalidBorder(invalid) }}
      />
      <label style={{ display: "flex", alignItems: "center", gap: "2px" }}>
        <input
          type="checkbox"
          checked={section.click}
          onChange={() => onChange({ ...section, click: !section.click })}
        />
        <span style={{ fontSize: "0.85em" }}>click</span>
      </label>
      <div style={{ display: "flex", gap: "2px", flex: 1, flexWrap: "wrap" }}>
        {drums.map((voice, i) => (
          <button
            key={i}
            onClick={() => toggleDrum(i)}
            title={`${section.drums.includes(i) ? "Silence" : "Sound"} ${drumLabel(
              voice.path
            )} in this section`}
            style={{
              fontSize: "0.8em",
              opacity: section.drums.includes(i) ? 1 : 0.4,
            }}
          >
            {drumLabel(voice.path)}
          </button>
        ))}
      </div>
      <button onClick={onRemove} title="Remove this section">
        ✕
      </button>
    </div>
  );
};

// The practice cycle: a list of stretches, run in order and then started again
// from the top. A count-off is a section, a groove is a section, a pause is a
// section with nothing turned on.
//
// There is deliberately no repeat count. A section says "for this many beats,
// these sound", and the rhythms tile on their own cycles, so running the groove
// four times is indistinguishable from making it four times as long -- write
// `bar*16` and the repeat is visible in the text.
export const SectionList = ({
  sections,
  setSections,
  drums,
  params,
}: {
  sections: Section[];
  setSections: (next: Section[]) => void;
  drums: DrumVoice[];
  params: Params;
}) => {
  let running = 0;
  const starts = sections.map((s) => {
    const at = running;
    if (s.on && sectionBeats(s) > 0) running += sectionBeats(s);
    return at;
  });
  const cycle = cycleBeatsOf(sections);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {sections.length > 0 && (
        <div style={{ ...rowStyle, color: "#aaa", fontSize: "0.8em" }}>
          <span style={{ width: "1.2em" }} />
          <span style={{ width: "4.5em" }}>at</span>
          <span style={{ width: "5em" }}>beats</span>
          <span style={{ flex: 1 }}>what sounds</span>
        </div>
      )}
      {sections.map((section, i) => (
        <SectionRow
          key={i}
          section={section}
          drums={drums}
          params={params}
          from={starts[i]}
          onChange={(next) =>
            setSections(sections.map((s, j) => (j === i ? next : s)))
          }
          onRemove={() => setSections(sections.filter((_, j) => j !== i))}
        />
      ))}
      <div style={rowStyle}>
        <button
          onClick={() => setSections([...sections, makeSection(drums)])}
          title="Add a stretch to the practice cycle"
        >
          + ADD SECTION
        </button>
        {sections.length ? (
          <span style={{ color: "#aaa", fontSize: "0.8em" }}>
            {Number(cycle.toPrecision(6))} beats, then it starts again -- every
            random parameter rerolled, the beat back to one, the looper cleared.
          </span>
        ) : (
          <span style={{ color: "#aaa", fontSize: "0.8em" }}>
            None -- everything sounds continuously. A count-off is a section with
            only a count-off voice on; a pause is a section with nothing on.
          </span>
        )}
      </div>
    </div>
  );
};
