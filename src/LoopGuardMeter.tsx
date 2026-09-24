import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api";
import { ui } from "./theme";

// What the loop guard is holding down, if anything.
//
// The guard is inert almost all of the time -- a band at 0 dB is an exact
// pass-through -- so without a readout there is nothing to distinguish "nothing
// is running away" from "this is switched on and broken". Same argument as the
// calibration showing its measurements whether it passed or failed.

export const LoopGuardMeter = ({ active }: { active: boolean }) => {
  const [state, setState] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    const poll = () =>
      invoke<[number, number]>("get_loop_guard")
        .then(setState)
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const [hz, db] = state ?? [0, 0];
  return (
    <div style={{ color: db >= 1 ? ui.warn : ui.text.muted, fontSize: "0.8em" }}>
      {db < 0.5
        ? "Nothing running away. Bands it is not holding are an exact pass-through."
        : `Holding ${hz.toFixed(0)} Hz down ${db.toFixed(1)} dB.`}
    </div>
  );
};
