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
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

const filesUnder = (dir, suffix) => {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(filesUnder(path, suffix));
    else if (e.name.endsWith(suffix)) out.push(path);
  }
  return out;
};

const dmgsUnder = (dir) => filesUnder(dir, ".dmg");

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
// already taken. All it prints is `error running bundle_dmg.sh`, which says
// nothing about a mount, so the name is freed here instead -- and the build is
// refused outright when it cannot be, rather than compiling, signing and
// spending a notarization round trip on a bundle that is going to fail at the
// last step anyway.
//
// Two ways the name gets taken, and the second is why matching on the backing
// image is not enough: the bundler's own `rw.*.dmg` scratch image stays
// attached after a failed run, *and* any copy of a released disk image mounted
// from anywhere -- Downloads, a USB stick, whatever was being carried to
// another machine -- claims the same name. The volume is identified by name
// for that reason; an image under `src-tauri/target` is additionally swept
// whatever it is called.
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

const productVolume = () => {
  try {
    const conf = JSON.parse(
      readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
    );
    return `/Volumes/${conf.package.productName}`;
  } catch {
    return null;
  }
};

const detach = (volume) => {
  try {
    execFileSync("hdiutil", ["detach", volume], { stdio: "ignore" });
    console.log(`detached ${volume}`);
    return true;
  } catch {
    return false;
  }
};

// Returns false when the build cannot succeed, so the caller can stop.
const freeDiskImageVolumes = () => {
  const wanted = productVolume();
  const mounted = new Set(volumesFromOurImages());
  if (wanted && existsSync(wanted)) mounted.add(wanted);

  for (const volume of mounted) detach(volume);

  if (!wanted || !existsSync(wanted)) return true;

  // Still there. The usual cause is the app running from the image, which no
  // amount of re-running will ever clear -- so name the process rather than
  // leaving the bundler's message to be interpreted.
  let holders = "";
  try {
    holders = execFileSync("lsof", ["+D", wanted], { encoding: "utf8" });
  } catch {}
  console.error(
    `\n${wanted} is mounted and will not detach, so bundle_dmg.sh cannot ` +
      `create it. Refusing to build: the disk image step would fail after ` +
      `the compile, the signing and a notarization round trip.\n` +
      (holders ? `\nHeld by:\n${holders}` : "") +
      `\nQuit whatever is using it (or eject the volume), then build again.\n`
  );
  return false;
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

// The release manifest the updater actually reads. Tauri builds the
// `.app.tar.gz` and signs it, and then stops -- `latest.json` is on you, and
// an update that is never published looks exactly like one nobody wanted.
//
// Written, never uploaded. Publishing is the step that puts code on other
// people's machines, so it stays a command you run on purpose; this prints it.
const writeReleaseManifest = (startedAt) => {
  const tarballs = filesUnder(target, ".app.tar.gz").filter(
    (f) => statSync(f).mtimeMs >= startedAt
  );
  if (!tarballs.length) return;

  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
  );
  const version = conf.package.version;
  const repo = "evogler/tauri-punching-bag";

  // The updater matches on this exactly, so it is derived rather than typed.
  // An x86_64 or universal build would need its own entry beside this one.
  const platform = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";

  let notes = "";
  try {
    notes = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {}

  const platforms = {};
  for (const tarball of tarballs) {
    const name = tarball.slice(tarball.lastIndexOf("/") + 1);
    let signature;
    try {
      signature = readFileSync(`${tarball}.sig`, "utf8").trim();
    } catch {
      console.error(
        `\n${name} has no .sig beside it, so the updater would reject it. ` +
          `TAURI_PRIVATE_KEY and TAURI_KEY_PASSWORD have to be set at build ` +
          `time -- see .env.signing.\n`
      );
      return;
    }
    platforms[platform] = {
      signature,
      url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
    };
  }

  const manifest = join(target, "release", "bundle", "latest.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      { version, notes, pub_date: new Date().toISOString(), platforms },
      null,
      2
    ) + "\n"
  );

  // The disk image goes up with them: the manifest and the tarball are what
  // the updater reads, but a friend installing for the *first* time needs
  // something to download, and a release without one is a link to nothing.
  const assets = [
    manifest,
    ...tarballs,
    ...dmgsUnder(target).filter((f) => statSync(f).mtimeMs >= startedAt),
  ];

  // Two commands rather than one, and `--notes` rather than letting it prompt.
  // `gh release create` with assets attached goes interactive without notes,
  // and that path uploads each asset twice -- which fails with
  // `ReleaseAsset.name already exists` blaming a duplicate that does not exist
  // on disk, and rolls the whole release back. Splitting them also means
  // `--clobber` can make a half-finished upload re-runnable.
  const quoted = `'${notes.replace(/'/g, "'\\''")}'`;
  console.log(
    `\nwrote ${manifest.slice(root.length + 1)} for v${version}. to publish:\n` +
      `  gh release create v${version} --title v${version} --notes ${quoted}\n` +
      `  gh release upload v${version} \\\n` +
      assets.map((a) => `    ${a.slice(root.length + 1)}`).join(" \\\n") +
      ` \\\n    --clobber\n`
  );
};

if (args[0] === "build" && !freeDiskImageVolumes()) process.exit(1);

const startedAt = Date.now();
const cli = spawn(join(root, "node_modules", ".bin", "tauri"), args, {
  stdio: "inherit",
});
cli.on("exit", (code, signal) => {
  if (code === 0 && args[0] === "build") {
    sweep(startedAt);
    notarizeDiskImages(startedAt);
    writeReleaseManifest(startedAt);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
