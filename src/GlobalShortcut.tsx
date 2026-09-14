import { useEffect, useRef, useState } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/api/globalShortcut";
import { BROWSER_DEBUG_MODE } from "./env";

// One system-wide key for pause/play, so the transport can be reached from
// whatever window is in front -- a DAW, a score, a video.
//
// Tauri v1 registers this through tao, which on macOS calls Carbon's
// `RegisterEventHotKey` (see tao's `platform_impl/macos/carbon_hotkey`). That
// is the old system hotkey API, not an event tap, so it needs **no
// Accessibility or Input Monitoring grant** -- which is the only reason this
// is a switch rather than a permissions flow.
//
// What that API gives it is also what makes it sharp: the key is taken from
// the whole machine, this app included, so it fires while a panel text field
// has focus and the character never reaches the field. Hence the modifier
// requirement below, and hence the default is a combination the in-app
// `keydown` listener refuses (it bails on `altKey`), so the two can never both
// fire for one press.
//
// Per machine and per person, not per preset: a preset that rebound someone
// else's keys would be the device choice in `audio-prefs.json` all over again.
// localStorage rather than that file, because nothing here is audio and
// nothing here is needed before a window exists.

const ON_KEY = "punching-bag.global-shortcut-on";
const ACCEL_KEY = "punching-bag.global-shortcut";

// ⌘⌥P. The alt is load-bearing: `App`'s own ⌘P/⌘L/⌘R listener returns early on
// `altKey`, so whichever of the two paths macOS delivers the press to, exactly
// one of them acts on it.
const DEFAULT_ACCEL = "CommandOrControl+Alt+P";

const MODIFIERS = new Set([
  "option", "alt", "control", "ctrl", "command", "cmd", "super", "shift",
  "commandorcontrol", "commandorctrl", "cmdorctrl", "cmdorcontrol",
]);

// A bare key would be taken from every application on the machine, so binding
// `P` would mean never typing a P again anywhere until this is switched off.
// Refused rather than allowed, because the way out of it is not obvious from
// inside the hole.
const hasModifier = (accel: string) =>
  accel.split("+").some((part) => MODIFIERS.has(part.trim().toLowerCase()));

const read = (key: string, fallback: string) => {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
};

const message = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : String(e);

// Every register/unregister goes through one chain. React runs an effect twice
// on mount under StrictMode, and two overlapping registrations of the same
// accelerator make the second one fail as already registered -- an error about
// nothing, reported over a binding that is actually working.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next as Promise<T>;
};

// Prettier than the accelerator string for a label, and only a label.
const glyphs = (accel: string) =>
  accel
    .split("+")
    .map((part) => {
      const p = part.trim().toLowerCase();
      if (p === "shift") return "⇧";
      if (p === "control" || p === "ctrl") return "⌃";
      if (p === "option" || p === "alt") return "⌥";
      if (MODIFIERS.has(p)) return "⌘";
      return part.trim().toUpperCase();
    })
    .join("");

export const GlobalShortcut = ({ onTrigger }: { onTrigger: () => void }) => {
  const [on, setOn] = useState(() => read(ON_KEY, "false") === "true");
  const [accel, setAccel] = useState(() => read(ACCEL_KEY, DEFAULT_ACCEL));
  const [text, setText] = useState(accel);
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState(0);

  // The handler is captured by the registration and outlives every render
  // after it, so it reaches the current transport through a ref -- the same
  // reason the ⌘P listener in `App` does.
  const trigger = useRef(onTrigger);
  trigger.current = onTrigger;

  useEffect(() => {
    if (!on || BROWSER_DEBUG_MODE) return;
    if (!hasModifier(accel)) {
      setError("Needs a modifier — a bare key would be taken from every app.");
      return;
    }
    let dropped = false;
    serial(async () => {
      try {
        await unregister(accel).catch(() => {});
        if (dropped) return;
        await register(accel, () => {
          trigger.current();
          setFired((n) => n + 1);
        });
        setError(null);
      } catch (e) {
        setError(message(e));
      }
    });
    return () => {
      dropped = true;
      serial(() => unregister(accel).catch(() => {}));
    };
  }, [on, accel]);

  const commit = () => {
    const next = text.trim();
    setText(next);
    if (next === accel) return;
    setAccel(next);
    setError(null);
    write(ACCEL_KEY, next);
  };

  const toggle = () => {
    const next = !on;
    setOn(next);
    if (!next) setError(null);
    write(ON_KEY, String(next));
  };

  if (BROWSER_DEBUG_MODE)
    return <div style={{ opacity: 0.7 }}>Only in the app, not the browser.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", flexDirection: "row", gap: 4 }}>
        <label>Pause from anywhere</label>
        <input type="checkbox" checked={on} onChange={toggle} />
      </div>
      <div style={{ display: "flex", flexDirection: "row", gap: 4 }}>
        <label>Key</label>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          style={{ borderColor: error ? "#c66" : undefined }}
        />
        <span style={{ opacity: 0.8 }}>{glyphs(accel)}</span>
      </div>
      {error && (
        <div style={{ color: "#fbb", fontSize: "0.85em" }}>{error}</div>
      )}
      {/* macOS does not tell an application that another one already owns a
          combination -- the registration succeeds and the press simply goes
          elsewhere -- so there is no error to show for the commonest failure.
          A count that moves when you press it is the only honest confirmation
          available. */}
      {on && !error && (
        <div style={{ opacity: 0.8, fontSize: "0.85em" }}>
          {fired === 0
            ? "Press it to check — macOS can give the key to another app without saying so."
            : `Fired ${fired}×`}
        </div>
      )}
    </div>
  );
};
