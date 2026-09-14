import { MAX_ANALYSIS_CHANNELS, VIEW_KINDS, ViewKind } from "../config";
import { ChannelPicker } from "../ChannelPicker";
import { GridList } from "../GridList";
import { Help } from "../help";
import { Input, TextInput } from "../Input";
import { RowColorList } from "../RowColorList";
import { RowPerNote } from "../RowPerNote";
import { Slider } from "../Slider";
import { SpectrogramControls } from "../SpectrogramControls";
import { Divider, Section } from "./chrome";
import { PanelProps } from "./types";

// The pane arrangements the panel offers, as [across, down].
const ARRANGEMENTS: [number, number][] = [
  [1, 1],
  [2, 1],
  [1, 2],
  [3, 1],
  [2, 2],
  [4, 1],
];

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
};

// How it is drawn: how many panes, and the settings of the one being edited.
// The frame every pane sits in is the layout tab.
export const DisplayTab = (p: PanelProps) => {
  const { get, set, params, viewCols, viewRows, setArrangement, paneCount, activeView, setSelectedView, channelLabels, inputChannelCount, activeCfg, viewIO, patchView } = p;
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
        {paneCount > 1 && (
          <Help
            id="panes"
            style={{
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              gap: "2px",
              margin: "4px 0",
            }}
          >
            {Array.from({ length: paneCount }, (_, index) => (
              <button
                key={index}
                onClick={() => setSelectedView(index)}
                style={{
                  flex: 1,
                  fontWeight: index === activeView ? "bold" : "normal",
                  backgroundColor: index === activeView ? "#666" : undefined,
                }}
              >
                Pane {index + 1}
              </button>
            ))}
          </Help>
        )}
      </Section>
      {/* Its own section, named for the pane, so it is plain that everything
          below the pane buttons belongs to the one selected. */}
      <Section label={paneCount > 1 ? `Pane ${activeView + 1}` : "Pane"}>
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
      </Section>
    </>
  );
};
