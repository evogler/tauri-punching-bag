import { DrumList } from "../DrumList";
import { Input } from "../Input";
import { SectionList } from "../SectionList";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// What the app plays: the click, the drum parts, and the cycle they run in.
// Tempo is pinned above the tabs, since everything here and in every other tab
// follows it; the file to play along with has a tab of its own.
export const PlayTab = (p: PanelProps) => {
  const { get, set, params, rustConfig, addDrumSample, sampleStatus } = p;
  return (
    <>
      <Section label="Click">
        <Input label="Click" _key="clickOn" set={set} get={get} />
        <Input
          label="Rhythm"
          _key="audioSubdivisions"
          params={params}
          set={set}
          get={get}
        />
        <Input label="Volume" _key="clickVolume" params={params} set={set} get={get} />
        {/* Beats, not milliseconds: the click is synthesised in the
            callback, so there is no file attack to align the way a drum
            voice's `offset` does. This is the musical half only. */}
        <Input
          label="Shift (beats)"
          _key="clickShift"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => Number.isFinite(n) && Math.abs(n) < 100000}
        />
      </Section>
      <Section label="Drums">
        <Input label="Drums" _key="drumOn" set={set} get={get} />
        <DrumList
          params={params}
          drums={get("drums")}
          setDrums={(next) => set("drums", next)}
          onAdd={addDrumSample}
          status={sampleStatus}
        />
      </Section>
      <Section label="Practice cycle">
        <Input label="Run the cycle" _key="sectionsOn" set={set} get={get} />
        <SectionList
          sections={get("sections")}
          setSections={(next) => set("sections", next)}
          order={get("sectionOrder")}
          setOrder={(next) => set("sectionOrder", next)}
          drums={rustConfig.drums}
          params={params}
        />
      </Section>
    </>
  );
};
