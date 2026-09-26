import React from "react";
import { useHelp } from "./help";
import { ui } from "./theme";
import { labelStyle } from "./Input";

/** Matches DEVICES_CHANGED_EVENT in src-tauri/src/platform/macos/devices.rs. */
export const DEVICES_CHANGED_EVENT = "devices-changed";
/** Match `audio_host.rs`: the audio restarted onto other devices, another
 *  input count or another rate -- or could not. */
export const AUDIO_RESTARTED_EVENT = "audio-restarted";
export const AUDIO_RESTART_FAILED_EVENT = "audio-restart-failed";

export type AudioDeviceInfo = {
  uid: string;
  name: string;
  inputChannels: number;
  /** 0 for a microphone. Each list is filtered on the count for its own
   *  direction: a device that cannot do the role must not be offered for it,
   *  because choosing one writes a UID that startup can only refuse. */
  outputChannels: number;
  sampleRate: number;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
};

export type AudioPrefs = {
  inputUid: string;
  outputUid: string;
  /** input uid -> output uid -> frames. Keyed by the pair because the value is
   *  a round trip: output latency and input latency both land in it. */
  pairCompensations: Record<string, Record<string, number>>;
};

/** What a latency figure is stored against. */
export const pairKey = (active: ActiveDevices) =>
  `${active.inputUid}\u0000${active.outputUid}`;

export const pairCompensation = (
  prefs: AudioPrefs,
  active: ActiveDevices | null
): number | undefined =>
  active ? prefs.pairCompensations?.[active.inputUid]?.[active.outputUid] : undefined;

export const withPairCompensation = (
  prefs: AudioPrefs,
  active: ActiveDevices,
  frames: number
): AudioPrefs => ({
  ...prefs,
  pairCompensations: {
    ...prefs.pairCompensations,
    [active.inputUid]: {
      ...(prefs.pairCompensations?.[active.inputUid] ?? {}),
      [active.outputUid]: frames,
    },
  },
});

export type ActiveDevices = {
  inputUid: string;
  inputName: string;
  outputUid: string;
  outputName: string;
  inputFellBack: boolean;
  outputFellBack: boolean;
  /** Why it fell back, in Rust's words. "Not found" and "found, but it has no
   *  output channels" are opposite problems to the person reading it. */
  inputFallbackReason?: string;
  outputFallbackReason?: string;
};

/** What is running, as `AudioStatus` in `structs.rs` has it. */
export type AudioStatus = {
  active: ActiveDevices;
  inputChannels: number;
  sampleRate: number;
};

/** `AudioRestarted` in `audio_host.rs`: what is running now, and what the
 *  restart had to let go of. */
export type AudioRestarted = {
  status: AudioStatus;
  rateChanged: boolean;
  channelsChanged: boolean;
  recordingStopped: boolean;
  calibrationCancelled: boolean;
  bleedReset: boolean;
  reason: string;
};

export const emptyPrefs = (): AudioPrefs => ({
  inputUid: "",
  outputUid: "",
  pairCompensations: {},
});

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

const noteStyle: React.CSSProperties = {
  fontSize: "11px",
  opacity: 0.7,
};

const describe = (d?: AudioDeviceInfo) =>
  !d
    ? ""
    : [
        d.inputChannels > 0 ? `${d.inputChannels} ch` : null,
        d.sampleRate > 0 ? `${Math.round(d.sampleRate)} Hz` : null,
      ]
        .filter(Boolean)
        .join(" · ");

/**
 * A choice applies at once: `setPrefs` writes the prefs file and restarts the
 * audio in-process (`restart_audio`). It used to wait for a relaunch, because
 * the render closure owned every per-channel buffer by value; the engine is a
 * value that can be rebuilt now. This still shows what is *running* beside
 * what is *chosen*, because the two can differ -- a saved device that is
 * unplugged, or cannot do its role, falls back to the system default -- and
 * says so in red. Nothing here is config: it lives in the prefs file, since a
 * preset carrying a device UID would be meaningless on another machine.
 */
export const DevicePicker = ({
  devices,
  active,
  prefs,
  setPrefs,
  onOpen,
  error,
}: {
  devices: AudioDeviceInfo[];
  active: ActiveDevices | null;
  prefs: AudioPrefs;
  setPrefs: (next: AudioPrefs) => void;
  onOpen: () => void;
  /** Why the last restart could not happen -- the device would not open, say.
   *  The audio is still on whatever was running before. */
  error?: string | null;
}) => {
  const inputs = devices.filter((d) => d.inputChannels > 0);
  // The output list used to be every device, microphones included. Picking one
  // wrote a UID that could never be opened as an output, and the next launch
  // panicked in Core Audio before any window existed to say so.
  const outputs = devices.filter((d) => d.outputChannels > 0);
  // An empty uid means "whatever macOS calls the default", which is the only
  // choice that keeps working when the machine's devices change underneath it
  // -- and the audio now follows the default when it moves.

  const help = useHelp();
  const select = (
    label: string,
    helpId: string,
    value: string,
    options: AudioDeviceInfo[],
    onPick: (uid: string) => void
  ) => (
    <div style={rowStyle} {...help(helpId)}>
      <label style={labelStyle}>{label}</label>
      {/* mousedown fires before the popup opens, so a device plugged in while
          the app was frontmost is picked up on the click that goes looking for
          it. The Core Audio listener normally beats this to it. */}
      <select
        value={value}
        onMouseDown={onOpen}
        onChange={(e) => onPick(e.target.value)}
      >
        <option value="">System default</option>
        {options.map((d) => (
          <option key={d.uid} value={d.uid}>
            {d.name}
            {describe(d) ? ` (${describe(d)})` : ""}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      {select("Input", "device.input", prefs.inputUid, inputs, (uid) =>
        setPrefs({ ...prefs, inputUid: uid })
      )}
      {select("Output", "device.output", prefs.outputUid, outputs, (uid) =>
        setPrefs({ ...prefs, outputUid: uid })
      )}

      {active && (
        <div style={noteStyle}>
          Now using: {active.inputName} → {active.outputName}
        </div>
      )}

      {/* A saved device that has been unplugged silently becomes the built-in
          mic. Say so loudly -- that failure is indistinguishable from a broken
          app until you notice which device is lit. */}
      {active?.inputFellBack && (
        <div style={{ ...noteStyle, color: ui.error }}>
          {active.inputFallbackReason || "Saved input device not found"} — using
          the system default
        </div>
      )}
      {active?.outputFellBack && (
        <div style={{ ...noteStyle, color: ui.error }}>
          {active.outputFallbackReason || "Saved output device not found"} —
          using the system default
        </div>
      )}

      {error && (
        <div style={{ ...noteStyle, color: ui.error }}>
          Could not switch: {error}
        </div>
      )}
    </div>
  );
};
