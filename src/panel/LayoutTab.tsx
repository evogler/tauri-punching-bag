import { ColorInput } from "../Input";
import { Slider } from "../Slider";
import { Divider, Section } from "./chrome";
import { PanelProps } from "./types";

export const LayoutTab = (p: PanelProps) => {
  const { get, set, gridWidth, paneScale, paneCount } = p;
  return (
    <>
      {/* The frame rather than the signal: what a pane sits on, and what
          sits between the panes. Global on purpose -- a gutter belongs to no
          one pane, and a background that differed pane by pane would read as
          a difference in what is being drawn. The per-pane palette is `row
          colors`, in the display tab. A tab of its own so it does not sit
          under the busiest one. */}
      <Section label="Look">
        <ColorInput
          label="Background"
          value={get("waveformBackground")}
          onChange={(c) => set("waveformBackground", c)}
          help="waveformBackground"
        />
        {/* CSS pixels rather than surface pixels, so a line is the same
            weight on the laptop screen and an external monitor. The note
            below resolves it against the ratio the panes were actually
            measured at, because "one device pixel" is the interesting end
            of this slider and it isn't a round number in CSS pixels. */}
        <Slider
          label="Grid line width"
          value={gridWidth}
          min={0.5}
          max={4}
          step={0.25}
          onChange={(n) => set("gridWidth", n)}
          help="gridWidth"
        />
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          {Math.max(1, Math.round(gridWidth * paneScale)) === 1
            ? "1 device pixel -- as thin as this display draws"
            : `${Math.max(
                1,
                Math.round(gridWidth * paneScale)
              )} device pixels`}
        </div>
        <Divider label="Between panes" />
        <Slider
          label="Gap"
          value={get("paneGap")}
          min={0}
          max={24}
          step={1}
          onChange={(n) => set("paneGap", n)}
          help="paneGap"
        />
        <ColorInput
          label="Gap color"
          value={get("paneGapColor")}
          onChange={(c) => set("paneGapColor", c)}
          help="paneGapColor"
        />
        {(paneCount < 2 || get("paneGap") === 0) && (
          <div style={{ color: "#aaa", fontSize: "0.8em" }}>
            No gutter to see -- needs more than one pane and a gap above 0.
          </div>
        )}
      </Section>
    </>
  );
};
