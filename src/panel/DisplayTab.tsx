import {
  MAX_ANALYSIS_CHANNELS,
  MAX_ROW_COLUMNS,
  VIEW_KINDS,
  ViewKind,
} from "../config";
import { ChannelPicker } from "../ChannelPicker";
import { GridList } from "../GridList";
import { Help } from "../help";
import { Input, TextInput } from "../Input";
import { RowColorList } from "../RowColorList";
import { RowPerNote } from "../RowPerNote";
import { Slider } from "../Slider";
import { SpectrogramControls } from "../SpectrogramControls";
import { PaneMap } from "../PaneMap";
import { paneLabel } from "../paneLayout";
import { Divider, Section } from "./chrome";
import { PanelProps } from "./types";

// The grids of cells the panel offers, as [across, down]. Finer grids earn
// their place now that a pane can span cells: 4x2 is where "one wide pane over
// two narrow ones" lives, which was not expressible when one cell meant one
// pane.
const ARRANGEMENTS: [number, number][] = [
  [1, 1],
  [2, 1],
  [1, 2],
  [3, 1],
  [2, 2],
  [4, 1],
  [3, 2],
  [4, 2],
];

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
};

// How it is drawn: how many panes, and the settings of the one being edited.
// The frame every pane sits in is the layout tab.
export const DisplayTab = (p: PanelProps) => {
  const { get, set, params, viewCols, viewRows, setArrangement, paneCount, activeView, setSelectedView, channelLabels, inputChannelCount, activeCfg, viewIO, patchView, views, paneOps } = p;
  return (
    <>
      <Section label="Panes">
        <Help id="arrangement" style={rowStyle}>
          <label>Arrangement</label>
          <select
            value={`${viewCols}x${viewRows}`}
            onChange={(e) => {
              const [cols, rows] = e.target.value.split("x").map(Number);
              setArrangement(cols, rows);
            }}
          >
            {ARRANGEMENTS.map(([cols, rows]) => (
              <option key={`${cols}x${rows}`} value={`${cols}x${rows}`}>
                {cols} across × {rows} down
              </option>
            ))}
          </select>
        </Help>
        <Input
          label="Run panes in sequence"
          _key="viewsSequential"
          set={set}
          get={get}
        />
        {/* The map is the pane selector as well as the layout editor: which
            pane the settings below belong to is a question about where it is
            on screen, so it is answered by pointing at it. */}
        <PaneMap
          views={views}
          cols={viewCols}
          rows={viewRows}
          activeView={activeView}
          setSelectedView={setSelectedView}
          ops={paneOps}
        />
      </Section>
      {/* Its own section, named for the pane, so it is plain that everything
          below the pane buttons belongs to the one selected. */}
      <Section
        label={paneCount > 1 ? paneLabel(views, activeView) : "Pane"}
      >
        {/* First, because it says which pane the rest of this belongs to --
            and a name is the one setting here that is about the pane rather
            than about what it draws. */}
        <TextInput
          label="Name"
          value={activeCfg?.name ?? ""}
          onChange={(name) => viewIO.set("name", name)}
          placeholder="none"
          help="pane.name"
        />
        <Divider label="What it shows" />
        <Help id="channels" style={{ ...rowStyle, alignItems: "center" }}>
          <label>Channels</label>
          <ChannelPicker
            labels={channelLabels}
            styles={get("channelStyles")}
            channels={activeCfg?.channels ?? []}
            setChannels={(next) => viewIO.set("channels", next)}
          />
        </Help>
        <Help id="kind" style={rowStyle}>
          <label>Display</label>
          <select
            value={activeCfg?.kind ?? "waveform"}
            onChange={(e) => viewIO.set("kind", e.target.value as ViewKind)}
          >
            {VIEW_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind[0].toUpperCase() + kind.slice(1)}
              </option>
            ))}
          </select>
        </Help>
        {activeCfg?.kind === "spectrogram" && (
          <SpectrogramControls
            cfg={activeCfg}
            labels={channelLabels}
            // Only the real inputs are analysed, and only the first few of
            // them -- the buses aren't captured and have no spectrum.
            count={Math.min(inputChannelCount, MAX_ANALYSIS_CHANNELS)}
            set={viewIO.set}
          />
        )}
        <Divider label="Rows" />
        {activeCfg && (
          <RowPerNote
            // Remounted with the pane, so switching panes closes the form
            // rather than leaving another pane's numbers in it.
            key={activeView}
            view={activeCfg}
            params={params}
            apply={(patch) => patchView(activeView, patch)}
          />
        )}
        <Input
          label="Beats per row"
          _key="beatsPerRow"
          params={params}
          {...viewIO}
        />
        {/* Under the row list, because it is about how those rows are laid
            out rather than about what a row is. A dropdown: it is a small
            integer with an upper bound, and there is nothing to type. */}
        <Help id="rowColumns" style={rowStyle}>
          <label>Columns of rows</label>
          <select
            value={activeCfg?.rowColumns ?? 1}
            onChange={(e) =>
              viewIO.set("rowColumns", Number(e.target.value))
            }
          >
            {Array.from({ length: MAX_ROW_COLUMNS }, (_, i) => i + 1).map(
              (n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 (full width)" : `${n} columns`}
                </option>
              )
            )}
          </select>
        </Help>
        <Input
          label="Lead-in (beats)"
          _key="marginLeft"
          params={params}
          {...viewIO}
        />
        <Input
          label="Lead-out (beats)"
          _key="marginRight"
          params={params}
          {...viewIO}
        />
        <Divider label="Drawing" />
        <Input
          label="Waveform size"
          _key="visualGain"
          params={params}
          {...viewIO}
        />
        <Input label="Split channels top/bottom" _key="splitChannels" {...viewIO} />
        <Input label="Color by loudness" _key="barColorMode" {...viewIO} />
        <Input
          label="Redraw once per pass"
          _key="refreshAtCycleEnd"
          {...viewIO}
        />
        <Divider label="Overlays" />
        {activeCfg?.kind === "waveform" && (
          <>
            <Input label="Show attack strength" _key="showFlux" {...viewIO} />
            {activeCfg?.showFlux && (
              <Slider
                label="Attack strength size"
                value={activeCfg.fluxGain}
                min={0.05}
                max={4}
                step={0.05}
                onChange={(n) => viewIO.set("fluxGain", n)}
                help="fluxGain"
              />
            )}
            <Input label="Show note starts" _key="showOnsets" {...viewIO} />
          </>
        )}
        <Divider label="Colors" />
        <Help id="rowColors">
          <RowColorList
            colors={activeCfg?.rowColors ?? []}
            setColors={(colors) => viewIO.set("rowColors", colors)}
          />
        </Help>
        {(activeCfg?.rowColors.length ?? 0) > 1 && (
          <>
            <Input
              label={
                activeCfg?.splitChannels
                  ? "Row color pattern (top)"
                  : "Row color pattern"
              }
              _key="rowColorPattern"
              params={params}
              {...viewIO}
            />
            {/* The halves are different channels, so one palette read
                through two patterns tells them apart without giving up the
                row marking. Empty means the lower half reads the pattern
                above it. */}
            {activeCfg?.splitChannels && (
              <Input
                label="Row color pattern (bottom)"
                _key="rowColorPatternDown"
                params={params}
                {...viewIO}
              />
            )}
          </>
        )}
        <Divider label="Grids" />
        <GridList
          grids={activeCfg?.grids ?? []}
          setGrids={(grids) => viewIO.set("grids", grids)}
          params={params}
        />
        {/* Everything above, in one go: taken from another pane, or thrown
            away. Both leave the pane where it is -- where a pane sits is the
            map's business, and nothing else here touches it. */}
        <Divider label="Start over" />
        {paneCount > 1 && (
          <Help id="paneCopy" style={{ ...rowStyle, alignItems: "center" }}>
            <label>Copy settings from</label>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value !== "")
                  paneOps.copyFrom(Number(e.target.value), activeView);
              }}
            >
              <option value="">Choose…</option>
              {views.map((_, i) =>
                i === activeView ? null : (
                  <option key={i} value={i}>
                    {paneLabel(views, i)}
                  </option>
                )
              )}
            </select>
          </Help>
        )}
        <Help id="paneReset" style={rowStyle}>
          <button style={{ flex: 1 }} onClick={() => paneOps.reset(activeView)}>
            Reset this pane
          </button>
        </Help>
      </Section>
    </>
  );
};
