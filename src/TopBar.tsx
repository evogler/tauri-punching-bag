import { useHelp } from "./help";
import { Input } from "./Input";
import { PanelProps } from "./panel/types";
import { ui } from "./theme";

// The bar across the top of the window: the transport, the tempo, the looper,
// and where the cycle has got to.
//
// **It is outside the panel, and that is the point.** These lived above the
// section rail, which meant clicking a pane to get the settings out of the way
// also took the transport with it -- so getting more picture cost you the
// ability to stop. Tempo belongs to no one section either, which is why it was
// pinned rather than filed in the first place.
//
// **There is no input meter and no latency figure**, though the mockups draw
// both. The meter was built, and then removed on the owner's question: what is
// the point of it, when the input is already drawn across the whole canvas?
// None worth the furniture. A meter earns its place in an application where
// nothing else shows you the signal, and the premise here is the opposite. The
// one thing it could say that the canvas cannot is that input is arriving
// *while paused*, when no visual samples are produced -- and that question is
// already answered by the setup wizard's microphone check, with a bar per
// channel rather than one for the loudest. The latency figure could only ever
// print `bufferCompensation` back, which is set in Setup and never moves on
// its own: a live-looking number that is not live.

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

export const TopBar = ({
  get,
  set,
  params,
  resetBeat,
  statusRef,
  clearHelp,
}: Pick<PanelProps, "get" | "set" | "params" | "resetBeat"> & {
  /**
   * Written by the draw loop with `textContent`, never through React: the beat
   * moves a hundred times a second, and a readout that re-rendered `App` at
   * that rate would cost more than the thing it reports on. The same rule
   * `showFrameTime` follows.
   */
  statusRef: React.RefObject<HTMLSpanElement>;
  clearHelp: () => void;
}) => {
  const help = useHelp();
  const paused = get("paused");
  const looping = get("loopingOn");

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

      <span
        ref={statusRef}
        style={{
          fontSize: "0.85em",
          color: ui.text.muted,
          whiteSpace: "nowrap",
        }}
        {...help("topbar.status")}
      />
    </div>
  );
};
