import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api";
import { BleedMeter } from "./BleedMeter";
import { Calibration } from "./Calibration";
import { exprNumber, numExpr } from "./config";
import {
  ActiveDevices,
  AudioDeviceInfo,
  AudioPrefs,
  DevicePicker,
} from "./DevicePicker";
import { ui } from "./theme";

// A first-launch walk through the few things that have to be right before the
// app is any use: it hears you, it is listening to the right device, it knows
// whether it is on speakers, and it draws you where you played. Everything
// here is a front for controls that already exist in the Setup tab -- this
// adds order and explanation, never a second way to store anything.

// Where setup has got to is install state, not config: kept out of presets and
// the session, in its own keys. localStorage may be unavailable, in which case
// setup behaves as though it has never run, which is harmless.
// The step by *name*. The key before this held an index into `STEPS`, and
// reordering the steps silently redefined every saved one -- the `loopFeedback`
// trap in list form. A name survives any future reordering, and renaming the
// key rather than reinterpreting it is what keeps an old index from being read
// as a position it never meant. `OLD_STEP_KEY` is still consulted for whether
// setup is part way through, and cleared alongside.
const STEP_KEY = "punching-bag.setup-at";
const OLD_STEP_KEY = "punching-bag.setup-step";
const DONE_KEY = "punching-bag.setup-done";
const store = {
  get: (k: string) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {}
  },
  remove: (k: string) => {
    try {
      window.localStorage.removeItem(k);
    } catch {}
  },
};

// Latency before the room, and that order is load-bearing rather than
// cosmetic: the bleed measurement is inferred through the `buffer_compensation`
// delay -- it peeks `BusDelay`, whose lead *is* that number -- so measuring it
// against a compensation nobody has set yet measures the wrong path and the
// check refuses, asking for the very thing the next step was going to do.
const STEPS = ["welcome", "devices", "microphone", "latency", "room", "done"] as const;

// Open at launch when setup is part way through -- changing a device restarts
// the app, and it has to come back to the step it left -- or on a fresh
// install. An install that already has a saved session was set up by hand
// before this existed and is not interrupted; Run setup again is in the Setup
// tab for it.
export const shouldOpenSetup = (hasSession: boolean) => {
  if (store.get(STEP_KEY) !== null || store.get(OLD_STEP_KEY) !== null) return true;
  if (store.get(DONE_KEY) === "true") return false;
  return !hasSession;
};

const text: React.CSSProperties = { lineHeight: 1.45, margin: "0 0 10px" };
const note: React.CSSProperties = { color: ui.text.muted, fontSize: "0.85em", lineHeight: 1.4 };

// Anything above about -60 dB proves sound is arriving at all, which is the
// question: the failure this exists to catch is an input of exact zeroes, which
// is what a missing microphone grant and a sample-rate mismatch both look like.
const HEARD = 0.001;
const SILENT_TICKS = 80; // 8 s at the poll rate

const MicCheck = ({ labels }: { labels: string[] }) => {
  const [levels, setLevels] = useState<number[]>([]);
  const [heard, setHeard] = useState(false);
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTicks((t) => t + 1);
      invoke<number[]>("get_input_levels")
        .then((peaks) => {
          // A falling bar rather than a flicker: each poll is only the peak of
          // the last tenth of a second.
          setLevels((prev) => peaks.map((p, i) => Math.max(p, (prev[i] ?? 0) * 0.8)));
          if (peaks.some((p) => p > HEARD)) setHeard(true);
        })
        .catch(() => {});
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <p style={text}>
        Play something, or clap. A bar below should move.
      </p>
      {levels.map((level, i) => {
        const db = 20 * Math.log10(Math.max(level, 1e-6));
        const fraction = Math.max(0, Math.min(1, (db + 60) / 60));
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
            <span style={{ width: "3.5em" }}>{labels[i] ?? `ch ${i + 1}`}</span>
            <div style={{ flex: 1, height: 8, background: ui.surface.well, borderRadius: 4 }}>
              <div
                style={{
                  width: `${fraction * 100}%`,
                  height: "100%",
                  borderRadius: 4,
                  background: db > -6 ? ui.bad : ui.ok,
                }}
              />
            </div>
            <span style={{ ...note, width: "4.5em", textAlign: "right" }}>
              {level > 1e-6 ? `${db.toFixed(0)} dB` : "silent"}
            </span>
          </div>
        );
      })}
      {heard ? (
        <p style={{ ...text, color: ui.ok, margin: "10px 0" }}>
          Sound is coming in. If your playing barely moves the bar, turn up the
          gain on your interface or move closer to the microphone.
        </p>
      ) : ticks > SILENT_TICKS ? (
        <div style={{ ...note, marginTop: 10, color: ui.notice }}>
          <p style={{ margin: "0 0 6px" }}>Still silent. The usual reasons, most likely first:</p>
          <ol style={{ margin: 0, paddingLeft: "1.3em" }}>
            <li>
              The app isn't allowed to use the microphone. Open System Settings →
              Privacy &amp; Security → Microphone, switch on Tauri Punching Bag,
              then restart the app.
            </li>
            <li>The wrong input is chosen -- go back a step and pick the one you're playing into.</li>
            <li>An interface's input gain is all the way down, or its input isn't switched on.</li>
          </ol>
        </div>
      ) : (
        <p style={{ ...note, marginTop: 10 }}>Listening…</p>
      )}
    </>
  );
};

export const SetupWizard = ({
  devices,
  active,
  prefs,
  setPrefs,
  refreshDevices,
  inputCount,
  channelLabels,
  get,
  set,
  sampleRate,
  onClose,
}: {
  devices: AudioDeviceInfo[];
  active: ActiveDevices | null;
  prefs: AudioPrefs;
  setPrefs: (next: AudioPrefs) => void;
  refreshDevices: () => void;
  inputCount: number;
  channelLabels: string[];
  get: (key: any) => any;
  set: (key: string, value: any) => void;
  sampleRate: number;
  onClose: () => void;
}) => {
  const [step, setStep] = useState(() => {
    // An index left by an older build is not a step name, so it reads as -1 and
    // setup starts from the top. Five skippable steps is the right price for
    // never resuming at a step that means something else now.
    const at = STEPS.indexOf(store.get(STEP_KEY) as (typeof STEPS)[number]);
    return at > 0 ? at : 0;
  });
  const [room, setRoom] = useState<"headphones" | "speakers" | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  // Written on every move, not only before a restart: the device picker's own
  // Restart button relaunches too, and setup must come back either way.
  useEffect(() => {
    store.set(STEP_KEY, STEPS[step]);
  }, [step]);

  const finish = () => {
    store.remove(STEP_KEY);
    store.remove(OLD_STEP_KEY);
    store.set(DONE_KEY, "true");
    onClose();
  };

  const name = STEPS[step];
  const pendingDevice =
    !!active &&
    ((prefs.inputUid !== "" && prefs.inputUid !== active.inputUid) ||
      (prefs.outputUid !== "" && prefs.outputUid !== active.outputUid));

  const next = () => {
    if (name === "done") return finish();
    if (name === "devices" && pendingDevice) {
      // Saved first: the relaunch is what brings setup back, one step on.
      store.set(STEP_KEY, STEPS[step + 1]);
      invoke("restart_app").catch(() => {});
      return;
    }
    setStep(step + 1);
  };

  const nextLabel =
    name === "welcome"
      ? "Start"
      : name === "done"
      ? "Start playing"
      : name === "devices" && pendingDevice
      ? "Restart and continue"
      : "Next";

  const title: Record<(typeof STEPS)[number], string> = {
    welcome: "Welcome to Punching Bag",
    devices: "Your audio devices",
    microphone: "Can it hear you?",
    room: "Headphones or speakers?",
    latency: "Line up what you play with where it's drawn",
    done: "You're set",
  };

  const latencyFrames = exprNumber(get("bufferCompensation"));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          boxSizing: "border-box",
          backgroundColor: ui.surface.inset,
          color: ui.text.primary,
          border: "1px solid #777",
          borderRadius: 10,
          padding: "18px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {name !== "welcome" && name !== "done" && (
          <div style={note}>
            Step {step} of {STEPS.length - 2}
          </div>
        )}
        <h2 style={{ margin: "0 0 6px", fontSize: "1.3em" }}>{title[name]}</h2>

        {name === "welcome" && (
          <>
            <p style={text}>
              Punching Bag is a metronome you play against: it draws what you
              play on a grid, so you can see exactly where each note lands.
            </p>
            <p style={text}>
              A minute of setup makes sure it hears you, and draws you where you
              actually played. Every step can be skipped, and you can run this
              again from the Setup tab.
            </p>
          </>
        )}

        {name === "devices" && (
          <>
            <p style={text}>
              Choose what you're playing into and what you're listening on. If
              you're using the Mac's own microphone and speakers or headphones,
              System default is right.
            </p>
            <DevicePicker
              devices={devices}
              active={active}
              prefs={prefs}
              setPrefs={setPrefs}
              onOpen={refreshDevices}
              onRestart={() => invoke("restart_app").catch(() => {})}
            />
            <p style={note}>
              A change takes effect after a restart. Setup picks up where you
              left off.
            </p>
          </>
        )}

        {name === "microphone" && (
          <MicCheck labels={channelLabels.slice(0, Math.max(1, inputCount))} />
        )}

        {name === "room" && (
          <>
            <p style={text}>
              On speakers, the microphone hears the click and drums as well as
              you, and they'd be drawn over your playing. The app can learn how
              your room sends them back, and take them out.
            </p>
            <div style={{ display: "flex", gap: 8, margin: "4px 0 8px" }}>
              {(["headphones", "speakers"] as const).map((choice) => (
                <button
                  key={choice}
                  onClick={() => {
                    setRoom(choice);
                    if (choice === "headphones") set("bleedCancelOn", false);
                  }}
                  style={{
                    flex: 1,
                    padding: "10px",
                    fontWeight: room === choice ? "bold" : undefined,
                    backgroundColor: room === choice ? ui.surface.selected : undefined,
                  }}
                >
                  {choice === "headphones" ? "Headphones" : "Speakers"}
                </button>
              ))}
            </div>
            {room === "headphones" && (
              <p style={note}>Nothing to measure -- headphones don't bleed.</p>
            )}
            {room === "speakers" && (
              <>
                <p style={note}>
                  Set the volume to where you'll play, then measure. Stay quiet
                  for the couple of seconds it runs. It works from the latency
                  measured on the last step, so redo that one first if you
                  change devices.
                </p>
                <BleedMeter
                  enabled={get("bleedCancelOn")}
                  onPassed={() => set("bleedCancelOn", true)}
                />
              </>
            )}
          </>
        )}

        {name === "latency" && (
          <>
            <p style={text}>
              Sound takes a moment to leave the speaker and come back into the
              microphone. Measuring it means your notes are drawn where you
              played them, not a little late.
            </p>
            {get("paused") && (
              <div style={{ ...note, color: ui.notice, display: "flex", gap: 8, alignItems: "center" }}>
                The measurement can't run while paused.
                <button onClick={() => set("paused", false)}>Resume</button>
              </div>
            )}
            <Calibration
              inputCount={inputCount}
              onApply={(frames) => {
                set("bufferCompensation", numExpr(frames));
                setApplied(frames);
              }}
            />
            {applied !== null ? (
              <p style={{ ...text, color: ui.ok }}>
                Applied: {applied} frames, about{" "}
                {((applied / sampleRate) * 1000).toFixed(1)} ms. Saved for this
                input and output.
              </p>
            ) : (
              <p style={note}>
                Currently {latencyFrames} frames (about{" "}
                {((latencyFrames / sampleRate) * 1000).toFixed(1)} ms).
              </p>
            )}
          </>
        )}

        {name === "done" && (
          <>
            <p style={text}>
              Start in the <b>Play</b> tab: set a tempo, turn on the click, and
              play against the lines.
            </p>
            <p style={text}>
              Point at anything in the panel and the strip at the bottom says
              what it does. Click a pane to hide the panel, and again to bring
              it back.
            </p>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          {name !== "done" && (
            <button onClick={finish} style={{ opacity: 0.75 }}>
              Skip setup
            </button>
          )}
          <span style={{ flex: 1 }} />
          {step > 0 && name !== "done" && (
            <button onClick={() => setStep(step - 1)}>Back</button>
          )}
          <button onClick={next} style={{ fontWeight: "bold", padding: "6px 14px" }}>
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
