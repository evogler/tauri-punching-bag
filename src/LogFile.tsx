import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ui } from "./theme";

// Where the app's log is, and a button that shows it in Finder. For the one
// moment it matters: something went wrong on a machine that isn't yours, and
// the file is what says what. The path is printed as well as revealed, so it
// can be read out over the phone.
export const LogFile = () => {
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    invoke<string | null>("get_log_path")
      .then(setPath)
      .catch((e) => setError(String(e)));
  }, []);

  const reveal = () =>
    invoke("reveal_log")
      .then(() => setError(null))
      .catch((e) => setError(String(e)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={reveal} disabled={!path}>
          Reveal log file
        </button>
      </div>
      <div
        style={{
          fontSize: "0.85em",
          color: ui.text.dim,
          overflowWrap: "anywhere",
        }}
      >
        {path ?? "No log file."}
      </div>
      {error && (
        <div style={{ color: ui.error, fontSize: "0.85em" }}>{error}</div>
      )}
    </div>
  );
};
