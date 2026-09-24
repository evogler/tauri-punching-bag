import { useHelp } from "../help";
import { Input } from "../Input";
import { Section } from "./chrome";
import { PanelProps } from "./types";
import { ui } from "../theme";

export const PanelHeader = (
  p: PanelProps & { helpVisible: boolean; toggleHelp: () => void }
) => {
  const { get, set, params, resetBeat, configError, helpVisible, toggleHelp } = p;
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
            backgroundColor: get("paused") ? ui.danger : undefined,
            color: get("paused") ? ui.text.bright : undefined,
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
            backgroundColor: helpVisible ? ui.surface.selected : undefined,
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
          tempo belongs to no one section, so both sit with the transport.
          Everything else that used to be pinned here is in the rail now. */}
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
            border: `1px solid ${ui.bad}`,
            borderRadius: 8,
            margin: 4,
            padding: 8,
            backgroundColor: ui.dangerFill,
            color: ui.error,
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
    </>
  );
};
