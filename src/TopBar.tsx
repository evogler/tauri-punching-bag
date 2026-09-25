import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import { useHelp } from "./help";
import { Input } from "./Input";
import { PanelProps } from "./panel/types";
import { ui } from "./theme";

// The bar across the top of the window: the transport, the tempo, the looper,
// where the cycle has got to, and the two numbers about the machine that you
// only ever want while you are playing.
//
// **It is outside the panel, and that is the point.** These lived above the
// section rail, which meant clicking a pane to get the settings out of the way
// also took the transport with it -- so getting more picture cost you the
// ability to stop. Tempo belongs to no one section either, which is why it was
// pinned rather than filed in the first place.
//
// Two readouts here are written **straight into the DOM from the draw loop and
// the meter poll, never through React**, the same rule `showFrameTime`
// follows: the beat moves a hundred times a second and the level fifteen, and
// a readout that re-rendered App at either rate would cost more than the thing
// it is reporting on.

const barStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "8px",
  flexShrink: 0,
  height: "42px",
  padding: "0 10px",
  boxSizing: "border-box",
  backgroundColor: ui.surface.panel,
  borderBottom: `1px solid ${ui.line.divider}`,
};

const readout: React.CSSProperties = {
  fontSize: "0.85em",
  color: ui.text.muted,
  whiteSpace: "nowrap",
};

export const TopBar = ({
  get,
  set,
  params,
  resetBeat,
  sampleRate,
  statusRef,
  meterPaused,
  clearHelp,
}: Pick<PanelProps, "get" | "set" | "params" | "resetBeat"> & {
  sampleRate: number;
  /** Written by the draw loop. See the note above. */
  statusRef: React.RefObject<HTMLSpanElement>;
  /**
   * `get_input_levels` reports the peak *since the last call*, so two pollers
   * split the peaks between them and both read low. The setup wizard's
   * microphone check is the other one, and it is the one that matters while it
   * is up.
   */
  meterPaused: boolean;
  clearHelp: () => void;
}) => {
  const help = useHelp();
  const paused = get("paused");
  const looping = get("loopingOn");
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (meterPaused) return;
    let held = 0;
    const timer = setInterval(() => {
      invoke<number[]>("get_input_levels")
        .then((peaks) => {
          // A falling bar rather than a flicker, exactly as the wizard's does:
          // each poll is only the peak of the last fraction of a second.
          held = Math.max(...peaks, 0, held * 0.8);
          const db = 20 * Math.log10(Math.max(held, 1e-6));
          const fraction = Math.max(0, Math.min(1, (db + 60) / 60));
          const el = fillRef.current;
          if (!el) return;
          el.style.width = `${fraction * 100}%`;
          el.style.backgroundColor = db > -6 ? ui.bad : ui.ok;
        })
        .catch(() => {});
    }, 66);
    return () => clearInterval(timer);
  }, [meterPaused]);

  // Frames, because that is the unit the key has always been in. What it means
  // in time depends on the device's rate, which is exactly why it is worth
  // printing here rather than leaving in Setup.
  const latencyMs = (get("bufferCompensation").val / sampleRate) * 1000;

  return (
    <div style={barStyle} onMouseLeave={clearHelp}>
      <button
        onClick={() => set("paused", !paused)}
        {...help("paused")}
        style={{
          fontWeight: "bold",
          minWidth: "6.5em",
          backgroundColor: paused ? ui.danger : undefined,
          color: paused ? ui.text.bright : undefined,
        }}
      >
        {paused ? "▶ Resume" : "⏸ Pause"}
      </button>
      <button onClick={resetBeat} {...help("restart")}>
        Restart
      </button>

      {/* The tempo keeps its expression field rather than gaining the +/-
          stepper the mockups draw. A stepper has to know what to add, and this
          field may hold `t` or `bar*20` -- there is no honest answer for what
          incrementing one of those means, and rounding it to a number would
          throw away the parameter the tempo was written against. */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <Input
          label="Tempo"
          _key="bpm"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => n > 0}
        />
      </div>

      <button
        onClick={() => set("loopingOn", !looping)}
        aria-pressed={looping}
        {...help("loopingOn")}
        style={{
          backgroundColor: looping ? ui.hintFill : undefined,
          borderColor: looping ? ui.hintEdge : undefined,
          color: looping ? ui.hintText : undefined,
        }}
      >
        Looper <span style={{ opacity: 0.7, fontSize: "0.85em" }}>⌘L</span>
      </button>

      <span ref={statusRef} style={readout} {...help("topbar.status")} />

      <span style={{ flexGrow: 1 }} />

      <span style={{ ...readout, display: "flex", alignItems: "center", gap: "6px" }} {...help("topbar.level")}>
        In
        <span
          aria-hidden="true"
          style={{
            width: "56px",
            height: "6px",
            borderRadius: "3px",
            backgroundColor: ui.surface.well,
            overflow: "hidden",
            display: "block",
          }}
        >
          <div
            ref={fillRef}
            style={{ width: "0%", height: "100%", backgroundColor: ui.ok }}
          />
        </span>
      </span>
      <span style={readout} {...help("topbar.latency")}>
        Latency {latencyMs.toFixed(1)} ms
      </span>
    </div>
  );
};
