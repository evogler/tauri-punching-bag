import { useCallback, useRef, useState } from "react";
import { HelpArea, HelpProvider } from "../help";
import { AnalysisTab } from "./AnalysisTab";
import { PanelTab, TabBar, TabPanel } from "./chrome";
import { DisplayTab } from "./DisplayTab";
import { FileTab } from "./FileTab";
import { LayoutTab } from "./LayoutTab";
import { LoopTab } from "./LoopTab";
import { PanelHeader } from "./PanelHeader";
import { PlayTab } from "./PlayTab";
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

// The settings panel: the pinned header and the tabs scroll, and the help area
// stays put beneath them. Which tab is open is held by App rather than here, so
// it survives the panel being hidden.
export const Panel = (
  p: PanelProps & { panelTab: PanelTab; setPanelTab: (tab: PanelTab) => void }
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
  const showRef = useRef<((id: string | null) => void) | null>(null);
  const show = useCallback((id: string | null) => showRef.current?.(id), []);
  const register = useCallback(
    (fn: ((id: string | null) => void) | null) => {
      showRef.current = fn;
    },
    []
  );

  return (
    <HelpProvider value={show}>
      <div
        onMouseLeave={() => show(null)}
        style={{
          display: "flex",
          flexDirection: "column",
          width: "600px",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "1px",
            gap: "2px",
            // Its own scrollbar against the canvas next to it -- the sections
            // outgrew the window a while ago. The help area does not scroll
            // with it, so it is always where you look for it.
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          <PanelHeader {...p} helpVisible={helpVisible} toggleHelp={toggleHelp} />

          <TabBar active={p.panelTab} onSelect={p.setPanelTab} />

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
        {helpVisible && <HelpArea register={register} />}
      </div>
    </HelpProvider>
  );
};
