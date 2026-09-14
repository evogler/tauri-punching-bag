import { invoke } from "@tauri-apps/api";
import { BleedMeter } from "../BleedMeter";
import { Calibration } from "../Calibration";
import { ChannelList } from "../ChannelList";
import { exprNumber, numExpr } from "../config";
import { DevicePicker } from "../DevicePicker";
import { BROWSER_DEBUG_MODE } from "../env";
import { Help } from "../help";
import { Input } from "../Input";
import { Updater } from "../Updater";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// What belongs to this machine rather than to the music: the devices, the
// latency between them, the inputs, the room on speakers, and updates. Mostly
// set once, which is why it is not the first tab.
export const SetupTab = (p: PanelProps) => {
  const { get, set, params, audioDevices, activeDevices, audioPrefs, writeAudioPrefs, refreshDevices, inputChannelCount, channelLabels, sampleRate, openSetup } = p;
  return (
    <>
      {/* First, so someone who skipped setup and is now stuck finds it. */}
      <Section>
        <Help id="setup.run">
          <button onClick={openSetup}>Run setup again</button>
        </Help>
      </Section>
      <Section label="Audio devices">
        <DevicePicker
          devices={audioDevices}
          active={activeDevices}
          prefs={audioPrefs}
          setPrefs={writeAudioPrefs}
          onOpen={refreshDevices}
          onRestart={() => invoke("restart_app").catch(() => {})}
        />
      </Section>
      {/* The measurement and the number it writes, together: they used to be
          two sections apart, which made the result look like it went nowhere. */}
      <Section label="Latency">
        <Help id="latency.measure">
          <Calibration
            inputCount={inputChannelCount}
            onApply={(frames) => set("bufferCompensation", numExpr(frames))}
          />
        </Help>
        <Input
          label="Latency (frames)"
          _key="bufferCompensation"
          params={params}
          set={set}
          get={get}
        />
        {/* Frames are the unit the key has always been in, and a device implies
            its own rate -- but milliseconds are what a person can picture. */}
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          ≈{" "}
          {(
            (exprNumber(get("bufferCompensation")) / sampleRate) *
            1000
          ).toFixed(1)}{" "}
          ms at {sampleRate} Hz
        </div>
      </Section>
      <Section label="Input">
        <Input label="Input gain" _key="audioInGain" params={params} set={set} get={get} />
        <ChannelList
          labels={channelLabels}
          inputCount={inputChannelCount}
          styles={get("channelStyles")}
          pans={get("channelPans")}
          gains={get("channelGains")}
          setStyles={(next) => set("channelStyles", next)}
          setPans={(next) => set("channelPans", next)}
          setGains={(next) => set("channelGains", next)}
        />
      </Section>
      {/* Measure first, then the switches that use the measurement. What it
          does to the looper's recording is over in the loop tab. */}
      <Section label="Playing on speakers">
        <Help id="bleed.measure">
          <BleedMeter enabled={get("bleedCancelOn")} />
        </Help>
        <Input
          label="Hide the app's sound from the picture"
          _key="bleedCancelOn"
          set={set}
          get={get}
        />
        <Input label="Keep adapting" _key="bleedTrackOn" set={set} get={get} />
      </Section>

      {/* With the device picker and Restart, because this is the tab that
          already holds what belongs to this install rather than to the
          music -- and installing an update restarts the app. */}
      {!BROWSER_DEBUG_MODE && (
        <Section label="Updates">
          <Help id="updates">
            <Updater />
          </Help>
        </Section>
      )}
    </>
  );
};
