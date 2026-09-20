#!/usr/bin/env node
// Merge a preset exported from the running app into src/examples.json.
//
// An example is built by *using* the app, never by writing JSON: set it up,
// save it as a preset, Manage… → export selected, then run this. A hand-written
// preset is the `audioSubdivisions` trap in CLAUDE.md -- a `val` that is not
// what its `inputText` parses to -- and nothing in the app would catch it.
//
//   yarn example:add exported.json
//   yarn example:add exported.json --id swing --description "…" --try "…"
//
// Re-exporting an example you have edited updates it in place and keeps its
// description, because the entry is matched by id and then by name.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = resolve(root, "src/examples.json");
const KIT = resolve(root, "src-tauri/samples/kit.json");

const die = (message) => {
  console.error(`add-example: ${message}`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++i] ?? "";
  else positional.push(arg);
}
if (positional.length !== 1)
  die("usage: yarn example:add <exported.json> [--id slug] [--description text] [--try text]");

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`could not read ${what} (${path}): ${e.message}`);
  }
};

const incoming = readJson(resolve(positional[0]), "the exported file");
if (!Array.isArray(incoming?.presets) || !incoming.presets.length)
  die("that file has no presets in it -- export from the app's Manage… dialog");
if (incoming.presets.length > 1 && flags.id)
  die("--id names one example, but that file holds several");

const target = readJson(TARGET, "src/examples.json");
if (!Array.isArray(target?.presets)) die("src/examples.json has no presets array");

const kitIds = new Set(readJson(KIT, "the kit list").map((k) => k.id));

// Ids are what the descriptions are keyed by and what a re-export matches, so
// they are stable slugs rather than the app's random preset ids.
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "example";

const warnings = [];
const warn = (name, message) => warnings.push(`${name}: ${message}`);

// An example runs on somebody else's machine, where a path out of this one
// means a voice that cannot sound and a file that cannot open. The kit sounds
// travel with the app; nothing else does.
const checkPortable = (name, preset) => {
  for (const voice of preset.rust?.drums ?? [])
    if (!kitIds.has(voice.path))
      warn(name, `drum voice "${voice.path}" is not a built-in kit sound`);
  if (preset.js?.filePath)
    warn(name, `points at a file (${preset.js.filePath}); nobody else has it`);
};

const results = [];
for (const entry of incoming.presets) {
  if (!entry || typeof entry.name !== "string" || !entry.name.trim())
    die("an entry in that file has no name");

  const wanted = flags.id || slug(entry.name);
  // By id first, so re-exporting an edited example updates it; then by name,
  // which is what happens when you save it in the app under the same name.
  const at =
    target.presets.findIndex((p) => p.id === wanted) >= 0
      ? target.presets.findIndex((p) => p.id === wanted)
      : target.presets.findIndex((p) => p.name === entry.name);
  const old = at >= 0 ? target.presets[at] : null;

  const next = {
    id: old?.id ?? wanted,
    name: entry.name,
    created: old?.created ?? entry.created ?? new Date().toISOString(),
    description: flags.description ?? old?.description ?? "",
    // `--try` because `try` is a reserved word wherever this ends up quoted.
    tryThis: flags.try ?? old?.tryThis ?? "",
    rust: entry.rust ?? {},
    js: entry.js ?? {},
  };
  checkPortable(next.name, next);
  if (!next.description.trim())
    warn(next.name, "no description yet -- add one in src/examples.json");

  if (at >= 0) target.presets[at] = next;
  else target.presets.push(next);
  results.push(`${at >= 0 ? "updated" : "added"} ${next.id} ("${next.name}")`);
}

// The app's own export carries `exported` and an app version; an example file
// is neither exported nor from one build, so those are dropped rather than
// carried across.
writeFileSync(
  TARGET,
  JSON.stringify(
    {
      format: target.format ?? "tauri-punching-bag presets",
      version: target.version ?? 1,
      app: "bundled",
      presets: target.presets,
    },
    null,
    2
  ) + "\n"
);

for (const line of results) console.log(line);
console.log(`src/examples.json now holds ${target.presets.length} examples`);
for (const line of warnings) console.warn(`  warning -- ${line}`);
