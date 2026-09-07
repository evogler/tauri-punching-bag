// `yarn tauri <args>` runs this instead of the CLI directly, so that a
// successful `build` can sweep the bundle tree afterwards. Everything else --
// `dev` above all -- is forwarded untouched, and a failed build is left exactly
// as it fell so there is something to look at.
//
// The sweep exists because a disk image that is not from this build looks
// identical to one that is. Shipping a stale one produced an app that refused
// to launch and then captured nothing, and every symptom of that is also what a
// correct build looks like when Gatekeeper, TCC or the sample rate is wrong --
// which is why it survived several rounds of plausible fixes aimed at the wrong
// thing. See "Installing on a second Mac" in CLAUDE.md.
import { spawn } from "node:child_process";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "src-tauri", "target");
const args = process.argv.slice(2);

const dmgsUnder = (dir) => {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(dmgsUnder(path));
    else if (e.name.endsWith(".dmg")) out.push(path);
  }
  return out;
};

// Anything older than the moment this build started is left over from some
// other one. Time rather than a name pattern: the bundler's `rw.` scratch image
// is only the case we happen to know about, and the 13 MB x64 image that
// actually caused trouble was named exactly like a real artifact.
const sweep = (startedAt) => {
  for (const dmg of dmgsUnder(target)) {
    if (statSync(dmg).mtimeMs >= startedAt) continue;
    unlinkSync(dmg);
    console.log(`removed stale disk image ${dmg.slice(root.length + 1)}`);
  }
};

const startedAt = Date.now();
const cli = spawn(join(root, "node_modules", ".bin", "tauri"), args, {
  stdio: "inherit",
});
cli.on("exit", (code, signal) => {
  if (code === 0 && args[0] === "build") sweep(startedAt);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
