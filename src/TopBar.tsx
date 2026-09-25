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

// `--label-col` is overridden here, and this is the one place it should be.
// The shared axis exists because the panel is a *column* of label-and-control
// rows and a ragged edge runs down the middle of it. The top bar is a row:
// there is no second row for Tempo to line up with, so a 12em label column
// only takes the width the field needs -- which is exactly what it did, the
// tempo field collapsing to nothing and the beat readout sliding over the
// looper. Scoped rather than opted out of with a prop, so the rows in here
// are still rows and the token is still the only thing that says how wide a
// label is.
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
  ["--label-col" as any]: "auto",
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

      {/* The readout is what gives when the window is too narrow for all of
          this, because it is the only thing here that can be read from the
          canvas instead. Truncated rather than allowed to overflow -- it sat
          across the looper button before, which reads as a broken bar rather
          than as a full one. */}
      <span
        ref={statusRef}
        style={{
          fontSize: "0.85em",
          color: ui.text.muted,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
        {...help("topbar.status")}
      />
    </div>
  );
};
