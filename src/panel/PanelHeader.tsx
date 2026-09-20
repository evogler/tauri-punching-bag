import { useHelp } from "../help";
import { Input } from "../Input";
import { ParameterList } from "../ParameterList";
import { ExampleBar } from "../ExampleBar";
import { PresetBar } from "../PresetBar";
import { Section } from "./chrome";
import { PanelProps } from "./types";

export const PanelHeader = (
  p: PanelProps & { helpVisible: boolean; toggleHelp: () => void }
) => {
  const { get, set, params, resetBeat, configError, setParameters, reroll, getCurrentPreset, loadPreset, helpVisible, toggleHelp } = p;
  const help = useHelp();
  return (
    <>
      <div style={{ display: "flex", flexDirection: "row", gap: "2px" }}>
        <button
          onClick={() => set("paused", !get("paused"))}
          {...help("paused")}
          style={{
            flex: 1,
            fontWeight: "bold",
            backgroundColor: get("paused") ? "#c44" : undefined,
            color: get("paused") ? "#fff" : undefined,
          }}
        >
          {get("paused") ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button onClick={resetBeat} {...help("restart")} style={{ flex: 1 }}>
          Restart from beat 1
        </button>
        {/* Keeps a tooltip: once the help area is hidden, it can't explain
            the button that brings it back. */}
        <button
          onClick={toggleHelp}
          {...help("helpToggle")}
          title={helpVisible ? "Hide help" : "Show help"}
          style={{
            width: "2.2em",
            fontWeight: "bold",
            backgroundColor: helpVisible ? "#666" : undefined,
          }}
        >
          ?
        </button>
      </div>
      {/* <button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_3.wav")}>
				NEW MP3 1
			</button>
			<button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_4.wav")}>
				NEW MP3 2
			</button> */}

      {/* Tempo and the looper are what gets reached for mid-practice, and
          tempo belongs to no one tab, so both sit with the transport. */}
      <Section>
        <Input
          label="Tempo (bpm)"
          _key="bpm"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => n > 0}
        />
        <Input label="Looper (⌘L)" _key="loopingOn" set={set} get={get} />
      </Section>

      {configError && (
        <div
          style={{
            border: "1px solid #e86",
            borderRadius: 8,
            margin: 4,
            padding: 8,
            backgroundColor: "#4a2a2a",
            color: "#fbb",
          }}
        >
          <b>A setting couldn't be applied, so what's playing doesn't match the
          panel.</b>{" "}
          Fix the field outlined in red and it will catch up.
          <div style={{ opacity: 0.8, fontSize: "0.85em", marginTop: 4 }}>
            {configError}
          </div>
        </div>
      )}

      {/* Not collapsed, unlike the two sections under it: this is the one
          part of the panel whose whole job is to be found by somebody who has
          just opened the app, and a closed heading is not found. */}
      <Section label="Examples">
        <ExampleBar getCurrent={getCurrentPreset} onLoad={loadPreset} />
      </Section>

      {/* Collapsed to start with, like parameters: reached for between
          sessions rather than during one. */}
      <Section label="Presets" startCollapsed>
        <PresetBar getCurrent={getCurrentPreset} onLoad={loadPreset} />
      </Section>

      {/* Pinned, because you edit `n` while looking at a field that reads
          `bar/n x n` in whichever tab is open -- but collapsed to start with,
          so a newcomer's first sight is not a list of variables. The count
          says whether there is anything inside. */}
      <Section
        label={`Parameters (${get("parameters").length})`}
        startCollapsed
        help="parameters"
      >
        <ParameterList
          parameters={get("parameters")}
          setParameters={setParameters}
          reroll={reroll}
        />
      </Section>
    </>
  );
};
