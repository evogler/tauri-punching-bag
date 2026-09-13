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
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "src-tauri", "target");
const args = process.argv.slice(2);

// Notarization credentials. Tauri reads APPLE_ID / APPLE_PASSWORD /
// APPLE_TEAM_ID from the environment and silently logs "skipping app
// notarization" when they are absent, so they have to be here before the CLI
// starts. The file is gitignored -- an app-specific password is a credential,
// and this repo is the one place it must never end up. A variable already
// exported in the shell wins, so CI can set them without touching the file.
const loadSigningEnv = () => {
  let text;
  try {
    text = readFileSync(join(root, ".env.signing"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
};

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

loadSigningEnv();

// `bundle_dmg.sh` creates /Volumes/<productName> and cannot when that name is
// already taken. The bundler's scratch image stays mounted after a failed run,
// so one failure makes every later one fail for a *different* reason than the
// first -- and all it prints is `error running bundle_dmg.sh`, which says
// nothing about a mount. The usual way the mount gets stuck is the app itself
// running from it, which no amount of re-running will ever clear, so the
// standing advice to just try again is wrong in exactly the case that matters.
const volumesFromOurImages = () => {
  let info;
  try {
    info = execFileSync("hdiutil", ["info"], { encoding: "utf8" });
  } catch {
    return [];
  }
  const out = [];
  let ours = false;
  for (const line of info.split("\n")) {
    const image = /^image-path\s*:\s*(.*)$/.exec(line);
    if (image) ours = image[1].startsWith(target);
    else if (ours) {
      const mount = /\s(\/Volumes\/\S.*)$/.exec(line);
      if (mount) out.push(mount[1]);
    }
  }
  return out;
};

const freeStaleVolumes = () => {
  for (const volume of volumesFromOurImages()) {
    try {
      execFileSync("hdiutil", ["detach", volume], { stdio: "ignore" });
      console.log(`detached stale build volume ${volume}`);
      continue;
    } catch {}
    let holders = "";
    try {
      holders = execFileSync("lsof", ["+D", volume], { encoding: "utf8" });
    } catch {}
    console.error(
      `\n${volume} is mounted and will not detach, so bundle_dmg.sh cannot ` +
        `create it and this build will fail at the disk image step.\n` +
        (holders ? `\nHeld by:\n${holders}` : "") +
        `\nQuit whatever is using it, then build again.\n`
    );
  }
};

// Tauri v1 notarizes the .app and then builds the disk image around it, so the
// image itself carries a signature and no ticket. That is enough for the app to
// launch -- its own ticket is stapled -- but not for the download: an
// unnotarized image is what Gatekeeper judges first, and it refuses to mount it
// with "Apple could not verify this is free of malware". Stapling the image too
// also means neither check needs the network.
const notarizeDiskImages = (startedAt) => {
  const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_PASSWORD || !APPLE_TEAM_ID) return;
  for (const dmg of dmgsUnder(target)) {
    if (statSync(dmg).mtimeMs < startedAt) continue;
    console.log(`notarizing ${dmg.slice(root.length + 1)}`);
    try {
      execFileSync(
        "xcrun",
        ["notarytool", "submit", dmg, "--apple-id", APPLE_ID,
         "--password", APPLE_PASSWORD, "--team-id", APPLE_TEAM_ID, "--wait"],
        { stdio: "inherit" }
      );
      execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    } catch {
      // The app inside is already notarized and stapled, so the build is not
      // worthless -- say plainly what is missing rather than failing it.
      console.error(
        `\nCould not notarize ${dmg.slice(root.length + 1)}. The app inside is ` +
          `notarized, but Gatekeeper will refuse this image once it has been ` +
          `downloaded. Do not ship it.\n`
      );
    }
  }
};

const startedAt = Date.now();
const cli = spawn(join(root, "node_modules", ".bin", "tauri"), args, {
  stdio: "inherit",
});
cli.on("exit", (code, signal) => {
  if (code === 0 && args[0] === "build") {
    sweep(startedAt);
    notarizeDiskImages(startedAt);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
