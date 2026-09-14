import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api";
import { save as saveFileDialog } from "@tauri-apps/api/dialog";
import { useHelp } from "./help";

// Writing the session to a WAV file.
//
// None of this is config: what is being recorded, and to where, is transport
// state like `paused`, and a preset that armed a recording over a path from
// another machine would be a surprise nobody asked for. So it lives here, in
// the component, and goes to Rust as arguments to `start_recording`.
//
// The path comes from a native save dialog and the file is opened by the
// command, which is the same route preset export takes -- the `fs` allowlist is
// scoped to `$RESOURCE/*` and could not reach it anyway.

type RecordingStatus = {
  recording: boolean;
  path: string;
  channels: number;
  frames: number;
  seconds: number;
  droppedFrames: number;
  error: string;
};

const basename = (path: string) => path.split("/").pop() || path;

const duration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export const Recorder = () => {
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [recordInput, setRecordInput] = useState(true);
  const [recordOutput, setRecordOutput] = useState(false);
  const [note, setNote] = useState("");
  const help = useHelp();
  const recording = status?.recording ?? false;

  // A poll rather than an event: the writer thread is the only thing that
  // knows how much has actually reached the disk, and the audio thread cannot
  // emit anything. Only while a recording is running -- a stopped one is not
  // going to change on its own.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!recording) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      invoke<RecordingStatus>("get_recording_status")
        .then(setStatus)
        .catch(() => {});
    }, 500);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [recording]);

  const start = async () => {
    setNote("");
    try {
      const path = await saveFileDialog({
        defaultPath: "session.wav",
        filters: [{ name: "wav", extensions: ["wav"] }],
      });
      if (typeof path !== "string") return;
      await invoke("start_recording", {
        path,
        input: recordInput,
        output: recordOutput,
      });
      setStatus(await invoke<RecordingStatus>("get_recording_status"));
    } catch (e) {
      // A bad path, a full disk, nothing chosen to record: the command opens
      // the file itself, so every one of those comes back here rather than
      // being discovered as a missing file afterwards.
      setNote(String(e));
    }
  };

  const stop = async () => {
    try {
      const final = await invoke<RecordingStatus>("stop_recording");
      setStatus(final);
      setNote(
        final.error
          ? `Recording failed: ${final.error}`
          : `Saved ${duration(final.seconds)} to ${basename(final.path)}`
      );
    } catch (e) {
      setNote(String(e));
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <label {...help("record.input")}>
          <input
            type="checkbox"
            checked={recordInput}
            disabled={recording}
            onChange={(e) => setRecordInput(e.target.checked)}
          />
          Input
        </label>
        <label {...help("record.output")}>
          <input
            type="checkbox"
            checked={recordOutput}
            disabled={recording}
            onChange={(e) => setRecordOutput(e.target.checked)}
          />
          Output mix
        </label>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
        {recording ? (
          <button onClick={stop} {...help("record.stop")}>
            ■ Stop
          </button>
        ) : (
          <button
            onClick={start}
            disabled={!recordInput && !recordOutput}
            {...help("record.start")}
          >
            ● Record…
          </button>
        )}
        {recording && status && (
          <span style={{ opacity: 0.8, fontSize: "0.9em" }}>
            {duration(status.seconds)} · {status.channels} ch ·{" "}
            {basename(status.path)}
          </span>
        )}
      </div>
      {/* Dropped frames mean the disk could not keep up. The callback drops
          rather than waiting, which is the only choice it has -- but a gap in a
          take must never be silent about itself. */}
      {status && status.droppedFrames > 0 && (
        <div style={{ color: "#e86", fontSize: "0.9em" }}>
          ⚠ {status.droppedFrames} frames dropped — the disk is not keeping up.
        </div>
      )}
      {status?.error && (
        <div style={{ color: "#e86", fontSize: "0.9em" }}>⚠ {status.error}</div>
      )}
      {note && !status?.error && (
        <div style={{ opacity: 0.8, fontSize: "0.9em" }}>{note}</div>
      )}
    </div>
  );
};
