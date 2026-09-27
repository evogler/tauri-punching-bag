import { useRef, useState } from "react";
import { HelpArea } from "../help";
import { AnalysisTab } from "./AnalysisTab";
import { ExampleHint, useExampleHint } from "../ExampleBar";
import { ExamplesTab } from "./ExamplesTab";
import { PanelTab, TabPanel, TabRail } from "./chrome";
import { DisplayTab } from "./DisplayTab";
import { FileTab } from "./FileTab";
import { LayoutTab } from "./LayoutTab";
import { LoopTab } from "./LoopTab";
import { PanelHeader } from "./PanelHeader";
import { ParametersTab } from "./ParametersTab";
import { PlayTab } from "./PlayTab";
import { PresetsTab } from "./PresetsTab";
import { SetupTab } from "./SetupTab";
import { PanelProps } from "./types";

// Whether the help area is showing is a per-machine convenience, not config:
// it stays out of presets and the session, and localStorage may be
// unavailable, in which case it is simply on.
const HELP_VISIBLE_KEY = "punching-bag.help-visible";
const readHelpVisible = () => {
  try {
    return window.localStorage.getItem(HELP_VISIBLE_KEY) !== "false";
  } catch {
    return true;
  }
};

// The settings panel: the settings scroll, the section rail down the left and
// the help area along the bottom stay put. Which section is open is held by App
// rather than here, so it survives the panel being hidden.
export const Panel = (
  p: PanelProps & {
    panelTab: PanelTab;
    setPanelTab: (tab: PanelTab) => void;
    // The help area is still the panel's, but *who is pointing at what* is
    // App's now: the top bar sits outside this component and its controls
    // have entries too.
    registerHelp: (show: ((id: string | null) => void) | null) => void;
    clearHelp: () => void;
  }
) => {
  const [helpVisible, setHelpVisible] = useState(readHelpVisible);
  const toggleHelp = () => {
    const next = !helpVisible;
    setHelpVisible(next);
    try {
      window.localStorage.setItem(HELP_VISIBLE_KEY, String(next));
    } catch {}
  };

  // The help area owns which entry is showing; this only forwards to it. A
  // stable function, so pointing at things never re-renders the tabs.
  // Which example is in effect, and whether anything has been changed since.
  // Up here because the picker sets it and the header shows it -- see
  // `useExampleHint`.
  const hint = useExampleHint(p.getCurrentPreset);

  // A leftward swipe across the panel puts it away, the way a sidebar goes on
  // iOS. Only a swipe that starts on the panel's own chrome counts: a slider,
  // a text field or a modal's drum grid is dragged sideways on purpose, and
  // hiding the panel under a finger that was moving a value would be the worst
  // possible answer. Clearly horizontal and clearly long, so a scroll that
  // drifts is never read as one. Touch only -- a mouse has the pane click.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const target = e.target as Element;
    swipeStart.current =
      e.touches.length === 1 &&
      !target.closest("input, select, textarea, [data-no-swipe]")
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (dx < -60 && Math.abs(dy) < Math.abs(dx) / 2) p.hidePanel();
  };


  return (
    <>
      <div
        onMouseLeave={p.clearHelp}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        // Its width is `.panel-shell` in index.css, not an inline style: 600px
        // beside the panes on a wide window, and the whole window, over them,
        // on a narrow one. A media query decides, so nothing here measures.
        className="panel-shell"
      >
        {/* The rail is a sibling of the scrolling settings, not inside them,
            which is the whole point of the column: the list of sections stays
            where you left it however far down the open one you are. */}
        <div style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0 }}>
          <TabRail active={p.panelTab} onSelect={p.setPanelTab} />

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "1px",
              gap: "2px",
              // Its own scrollbar against the canvas next to it -- the sections
              // outgrew the window a while ago. Neither the rail nor the help
              // area scrolls with it, so both are always where you look.
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            <PanelHeader {...p} helpVisible={helpVisible} toggleHelp={toggleHelp} />

            {hint.showing && (
              <ExampleHint example={hint.showing} onDismiss={hint.dismiss} />
            )}

            <TabPanel active={p.panelTab === "examples"}>
              <ExamplesTab {...p} onLoaded={hint.loaded} />
            </TabPanel>
            <TabPanel active={p.panelTab === "presets"}>
              <PresetsTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "parameters"}>
              <ParametersTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "play"}>
              <PlayTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "file"}>
              <FileTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "loop"}>
              <LoopTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "display"}>
              <DisplayTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "layout"}>
              <LayoutTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "setup"}>
              <SetupTab {...p} />
            </TabPanel>
            <TabPanel active={p.panelTab === "analysis"}>
              <AnalysisTab {...p} />
            </TabPanel>
          </div>
        </div>
        {helpVisible && <HelpArea register={p.registerHelp} />}
      </div>
    </>
  );
};
