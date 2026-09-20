import React from "react";
import { useHelp } from "./help";

/** Matches DEVICES_CHANGED_EVENT in src-tauri/src/io_channels.rs. */
export const DEVICES_CHANGED_EVENT = "devices-changed";

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
 * Device choice takes effect at startup, not live -- the render closure owns
 * every per-channel buffer by value, so swapping under it would mean a lock the
 * audio thread could wait on. So this shows what is *running* alongside what is
 * *chosen*, and offers the relaunch when they differ. Nothing here is config:
 * it lives in the prefs file, since a preset carrying a device UID would be
 * meaningless on another machine.
 */
export const DevicePicker = ({
  devices,
  active,
  prefs,
  setPrefs,
  onOpen,
  onRestart,
}: {
  devices: AudioDeviceInfo[];
  active: ActiveDevices | null;
  prefs: AudioPrefs;
  setPrefs: (next: AudioPrefs) => void;
  onOpen: () => void;
  onRestart: () => void;
}) => {
  const inputs = devices.filter((d) => d.inputChannels > 0);
  // The output list used to be every device, microphones included. Picking one
  // wrote a UID that could never be opened as an output, and the next launch
  // panicked in Core Audio before any window existed to say so.
  const outputs = devices.filter((d) => d.outputChannels > 0);
  // An empty uid means "whatever macOS calls the default", which is the only
  // choice that keeps working when the machine's devices change underneath it.
  const pending =
    !!active &&
    ((prefs.inputUid !== "" && prefs.inputUid !== active.inputUid) ||
      (prefs.outputUid !== "" && prefs.outputUid !== active.outputUid));

  const help = useHelp();
  const select = (
    label: string,
    helpId: string,
    value: string,
    options: AudioDeviceInfo[],
    onPick: (uid: string) => void
  ) => (
    <div style={rowStyle} {...help(helpId)}>
      <label>{label}</label>
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
        <div style={{ ...noteStyle, color: "#e08" }}>
          {active.inputFallbackReason || "Saved input device not found"} — using
          the system default
        </div>
      )}
      {active?.outputFellBack && (
        <div style={{ ...noteStyle, color: "#e08" }}>
          {active.outputFallbackReason || "Saved output device not found"} —
          using the system default
        </div>
      )}

      {pending && (
        <div style={rowStyle}>
          <button onClick={onRestart}>Restart to apply</button>
          <span style={noteStyle}>Device changes take effect after a restart</span>
        </div>
      )}
    </div>
  );
};
