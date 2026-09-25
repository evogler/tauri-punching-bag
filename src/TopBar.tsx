import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import { useHelp } from "./help";
import { Input } from "./Input";
import { PanelProps } from "./panel/types";
import { ui } from "./theme";

// The bar across the top of the window: the transport, the tempo, the looper,
// where the cycle has got to, and what the inputs are hearing.
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

/// Below this a poll counts as having heard nothing. About -54 dB: quiet
/// enough to be room noise on any sane input trim, loud enough that a real
/// note clears it comfortably.
const SILENT = 0.002;
/// Three seconds at the poll rate below, so a gap between phrases does not
/// make the meter announce itself.
const SILENT_POLLS = 60;

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
  statusRef,
  meterPaused,
  clearHelp,
}: Pick<PanelProps, "get" | "set" | "params" | "resetBeat"> & {
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
  const dbRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (meterPaused) return;
    let held = 0;
    // **An empty meter and a broken meter look identical**, which is the whole
    // reason this says something rather than only drawing a bar: a 6px trough
    // that never moves reads as "this feature does nothing", and the honest
    // answers -- nothing is arriving, or nothing is being played -- are
    // completely different problems. Counted in polls rather than seconds so
    // it needs no clock.
    let quiet = 0;
    const timer = setInterval(() => {
      invoke<number[]>("get_input_levels")
        .then((peaks) => {
          const now = Math.max(...peaks, 0);
          quiet = now > SILENT ? 0 : quiet + 1;
          // A falling bar rather than a flicker, exactly as the wizard's does:
          // each poll is only the peak of the last fraction of a second.
          held = Math.max(now, held * 0.85);
          const db = 20 * Math.log10(Math.max(held, 1e-6));
          const fraction = Math.max(0, Math.min(1, (db + 60) / 60));
          const bar = fillRef.current;
          if (bar) {
            bar.style.width = `${fraction * 100}%`;
            bar.style.backgroundColor = db > -6 ? ui.bad : ui.ok;
          }
          const text = dbRef.current;
          if (text) {
            const silent = quiet > SILENT_POLLS;
            text.textContent = silent ? "silent" : `${Math.round(db)} dB`;
            text.style.color = silent ? ui.text.dim : ui.text.muted;
          }
        })
        .catch(() => {
          const text = dbRef.current;
          if (text) {
            text.textContent = "no input";
            text.style.color = ui.error;
          }
        });
    }, 50);
    return () => clearInterval(timer);
  }, [meterPaused]);

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

      <span
        style={{ ...readout, display: "flex", alignItems: "center", gap: "6px" }}
        {...help("topbar.level")}
      >
        In
        <span
          aria-hidden="true"
          style={{
            width: "72px",
            height: "9px",
            borderRadius: "2px",
            backgroundColor: ui.surface.well,
            border: `1px solid ${ui.line.divider}`,
            overflow: "hidden",
            display: "block",
            boxSizing: "border-box",
          }}
        >
          <div
            ref={fillRef}
            style={{ width: "0%", height: "100%", backgroundColor: ui.ok }}
          />
        </span>
        {/* The number is what makes the bar believable. A trough that has not
            moved says nothing about whether anything is arriving; a figure
            that reads "silent" and then "-22 dB" when you clap says it
            exactly. Written into the DOM like the bar beside it. */}
        <span ref={dbRef} style={{ width: "4.2em", fontFamily: ui.mono }}>
          silent
        </span>
      </span>
    </div>
  );
};
