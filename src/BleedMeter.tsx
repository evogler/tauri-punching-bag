import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api";

// Measuring the speaker's bleed, and saying what it managed.
//
// A button rather than something continuous, and `bleed.rs` has the long
// version of why: an adaptive filter left running cannot tell the difference
// between cancelling the speaker and cancelling *you*, and neither can anything
// the app could check afterwards. Measured in two and a half seconds of silence
// the answer is trustworthy, and the reduction it achieved is a real number
// rather than a hope.
//
// Shaped like the latency calibration next to it, including showing the
// measurements behind a failure: "nothing came back" and "something came back
// and would not cancel" need opposite responses.

type Phase = "idle" | "running" | "done" | "failed";

type BleedResult = {
  phase: Phase;
  progress: number;
  db: number;
  inputPeakDb: number;
  message: string;
  minDb: number;
  minInputPeakDb: number;
  liveDb: number;
  liveDuty: number;
};

export const BleedMeter = ({ enabled }: { enabled: boolean }) => {
  const [result, setResult] = useState<BleedResult | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const running = result?.phase === "running";

  useEffect(() => {
    invoke<BleedResult>("get_bleed_status").then(setResult).catch(() => {});
  }, []);

  // Fast while a run is in flight, slow while it is only reporting what the
  // tracking is doing, and not at all when the whole thing is switched off.
  const measured = result?.phase === "done";
  useEffect(() => {
    if (!running && !(enabled && measured)) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      invoke<BleedResult>("get_bleed_status").then(setResult).catch(() => {});
    }, running ? 100 : 500);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [running, enabled, measured]);

  const start = () =>
    invoke("start_bleed_training")
      .then(() =>
        setResult({
          phase: "running",
          progress: 0,
          db: 0,
          inputPeakDb: -120,
          message: "",
          minDb: 6,
          minInputPeakDb: -50,
          liveDb: 0,
          liveDuty: 0,
        })
      )
      .catch(() => {});

  const note = (text: string, color = "#aaa") => (
    <div style={{ color, fontSize: "0.8em" }}>{text}</div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={start} disabled={running}>
          {running ? "measuring…" : "measure bleed"}
        </button>
        {running && <span>{Math.round((result?.progress ?? 0) * 100)}%</span>}
      </div>

      {note(
        "Plays a couple of seconds of noise and listens for it coming back. " +
          "Stay quiet while it runs -- anything you play is something it would " +
          "try to subtract later."
      )}

      {result?.phase === "done" &&
        note(result.message, result.db >= 12 ? "#8c8" : "#cc8")}
      {result?.phase === "failed" && note(result.message, "#fbb")}
      {result?.phase === "failed" &&
        note(
          `heard ${result.inputPeakDb.toFixed(1)} dB back ` +
            `(needs ${result.minInputPeakDb.toFixed(0)}), removed ` +
            `${result.db.toFixed(1)} dB (needs ${result.minDb.toFixed(0)}).`
        )}

      {enabled && result?.phase !== "done" &&
        note(
          "Switched on, but nothing has been measured yet -- press measure bleed.",
          "#cc8"
        )}
      {enabled && result?.phase === "done" && !running &&
        note(
          result.liveDuty > 0.01
            ? `Following the room: ${result.liveDb.toFixed(1)} dB removed, ` +
              `learning from ${(result.liveDuty * 100).toFixed(0)}% of frames.`
            : "Holding the measured filter -- it only learns from moments it can " +
              "already explain, so it stops while you play.",
          result.liveDuty > 0.01 ? "#8c8" : "#aaa"
        )}
      {enabled && result?.phase === "done" &&
        note("Picture only -- the looper still records what the microphone heard.")}
      {!enabled && note("Off -- on headphones there is no bleed to hide.")}
    </div>
  );
};
