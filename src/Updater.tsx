import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkUpdate,
  installUpdate,
  onUpdaterEvent,
} from "@tauri-apps/api/updater";

// The manual half of the updater. `dialog: true` in tauri.conf.json already
// gives a native prompt at launch, which is the whole interaction for anyone
// who just wants the new version -- this is for asking on purpose.
//
// The two paths are genuinely separate in the crate: the launch check runs
// `prompt_for_install`, and `checkUpdate()` from here goes through a listener
// that never reads the `dialog` setting. So nothing here is duplicated by the
// dialog, and nothing here can raise one.
//
// That asymmetry is also why this relaunches itself. The dialog path installs
// and then asks "Ready to Restart" on its own; the JS path only emits `DONE`
// and returns, so an update installed from here would sit on disk unmentioned
// until the next launch. `restart_app` is the same command the menu's Restart
// uses -- `AppHandle::restart` reads Info.plist, so the *bundle* comes back
// rather than the bare binary, which is the half that can hold the microphone
// grant.

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "installing" }
  | { kind: "installed" }
  | { kind: "error"; message: string };

const message = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : String(e);

export const Updater = () => {
  const [state, setState] = useState<State>({ kind: "idle" });

  // What is actually running, read from the bundle rather than from anything
  // this side could get out of step with. Without it an update that installed
  // and an update that silently did nothing look identical -- which is the
  // whole question you open this section to answer.
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // An updater failure is silent by construction -- the app goes on working
  // perfectly while quietly never updating again -- so the error is surfaced
  // rather than inferred. Deliberately *here* and not in the config banner:
  // the launch check fires this every time the machine is offline, which is
  // ordinary rather than something to shout about.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dropped = false;
    onUpdaterEvent(({ error, status }) => {
      if (error) setState({ kind: "error", message: error });
      else if (status === "DONE") setState({ kind: "installed" });
    })
      .then((fn) => (dropped ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      dropped = true;
      unlisten?.();
    };
  }, []);

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const { shouldUpdate, manifest } = await checkUpdate();
      setState(
        shouldUpdate
          ? {
              kind: "available",
              version: manifest?.version ?? "",
              notes: manifest?.body ?? "",
            }
          : { kind: "current" }
      );
    } catch (e) {
      setState({ kind: "error", message: message(e) });
    }
  };

  const install = async () => {
    setState({ kind: "installing" });
    try {
      await installUpdate();
      setState({ kind: "installed" });
      await invoke("restart_app");
    } catch (e) {
      setState({ kind: "error", message: message(e) });
    }
  };

  const busy = state.kind === "checking" || state.kind === "installing";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ opacity: 0.8 }}>{version && `v${version}`}</span>
        <button onClick={check} disabled={busy}>
          Check for updates
        </button>
        {state.kind === "checking" && <span>Checking…</span>}
        {state.kind === "current" && <span>Up to date</span>}
        {state.kind === "installing" && <span>Installing…</span>}
        {state.kind === "installed" && <span>Installed — restarting…</span>}
      </div>

      {state.kind === "available" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{state.version} available</span>
            <button onClick={install}>Install and restart</button>
          </div>
          {state.notes && (
            <div style={{ opacity: 0.8, fontSize: "0.85em" }}>
              {state.notes}
            </div>
          )}
        </div>
      )}

      {state.kind === "error" && (
        <div style={{ color: "#fbb", fontSize: "0.85em" }}>
          Update check failed: {state.message}
        </div>
      )}
    </div>
  );
};
