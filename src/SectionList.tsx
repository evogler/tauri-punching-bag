import {
  DrumVoice,
  NumberListExpr,
  Section,
  cycleBeatsOf,
  cycleSteps,
  drumLabel,
  sectionBeats,
  sectionShown,
} from "./config";
import { Params, evaluate, parseNumberList } from "./expression";
import { useHelp } from "./help";
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
  show: true,
  // A new section starts with everything sounding, which is the section you
  // most often want; a count-off or a pause is then a matter of turning things
  // off rather than hunting for what to turn on.
  drums: drums.map((_, i) => i),
});

const SectionRow = ({
  section,
  drums,
  params,
  number,
  onChange,
  onRemove,
}: {
  section: Section;
  drums: DrumVoice[];
  params: Params;
  /** 1-based, which is how the order field refers to it. */
  number: number;
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
  const help = useHelp();
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
        {...help("sections.on")}
      />
      <span
        style={{ width: "2em", color: "#aaa", fontSize: "0.8em" }}
        {...help("sections.number")}
      >
        {number}
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
        {...help("sections.beats")}
        style={{ width: "5em", ...invalidBorder(invalid) }}
      />
      <label
        style={{ display: "flex", alignItems: "center", gap: "2px" }}
        {...help("sections.click")}
      >
        <input
          type="checkbox"
          checked={section.click}
          onChange={() => onChange({ ...section, click: !section.click })}
        />
        <span style={{ fontSize: "0.85em" }}>Click</span>
      </label>
      <label
        style={{ display: "flex", alignItems: "center", gap: "2px" }}
        {...help("sections.show")}
      >
        <input
          type="checkbox"
          checked={sectionShown(section)}
          onChange={() =>
            onChange({ ...section, show: !sectionShown(section) })
          }
        />
        <span style={{ fontSize: "0.85em" }}>Show</span>
      </label>
      <div
        style={{ display: "flex", gap: "2px", flex: 1, flexWrap: "wrap" }}
        {...help("sections.drums")}
      >
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
  order,
  setOrder,
  drums,
  params,
}: {
  sections: Section[];
  setSections: (next: Section[]) => void;
  order: NumberListExpr;
  setOrder: (next: NumberListExpr) => void;
  drums: DrumVoice[];
  params: Params;
}) => {
  const [orderProps, setOrderText] = useFocusedValue(order.inputText, {
    toString: (x) => x as string,
  });
  // Empty is not typeable -- parseNumberList refuses an empty list -- so the
  // way back to "in order" is to clear the field, which simply stops
  // committing and leaves the last good value. Same shape as rowColorPattern.
  const orderInvalid =
    orderProps.value.trim() !== "" &&
    !accepts(() => parseNumberList(orderProps.value, params));
  const steps = cycleSteps(sections, order);
  const cycle = cycleBeatsOf(sections, order);
  const help = useHelp();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {sections.length > 0 && (
        <div style={{ ...rowStyle, color: "#aaa", fontSize: "0.8em" }}>
          <span style={{ width: "1.2em" }} />
          <span style={{ width: "2em" }} {...help("sections.number")}>#</span>
          <span style={{ width: "5em" }} {...help("sections.beats")}>Beats</span>
          <span style={{ flex: 1 }} {...help("sections.drums")}>What sounds</span>
        </div>
      )}
      {sections.map((section, i) => (
        <SectionRow
          key={i}
          section={section}
          drums={drums}
          params={params}
          number={i + 1}
          onChange={(next) =>
            setSections(sections.map((s, j) => (j === i ? next : s)))
          }
          onRemove={() => setSections(sections.filter((_, j) => j !== i))}
        />
      ))}
      {sections.length > 1 && (
        <div style={{ ...rowStyle, marginTop: "2px" }} {...help("sectionOrder")}>
          <label>Order</label>
          <input
            {...orderProps}
            onChange={(e) => {
              const text = e.target.value;
              setOrderText(text);
              try {
                setOrder({ inputText: text, val: parseNumberList(text, params) });
              } catch (e) {}
            }}
            style={{ flex: 1, minWidth: 0, ...invalidBorder(orderInvalid) }}
          />
        </div>
      )}
      <div style={rowStyle}>
        <button
          onClick={() => setSections([...sections, makeSection(drums)])}
          {...help("sections.add")}
        >
          Add section
        </button>
        {sections.length ? (
          <span style={{ color: "#aaa", fontSize: "0.8em" }}>
            {steps.map((s) => s.section + 1).join(" ") || "nothing"} --{" "}
            {Number(cycle.toPrecision(6))} beats, then it starts again: every
            random parameter rerolled, the beat back to one, the looper cleared.
          </span>
        ) : (
          <span style={{ color: "#aaa", fontSize: "0.8em" }}>
            None -- everything sounds continuously. A count-off is a section with
            only a count-off voice on and "Show" unticked; a pause is a section
            with nothing on.
          </span>
        )}
      </div>
    </div>
  );
};
