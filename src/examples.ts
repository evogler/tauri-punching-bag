import rawFile from "./examples.json";
import { Preset, parsePresetFile } from "./presets";

/// A bundled, read-only preset that teaches one idea.
///
/// Stored as an ordinary *preset file* with two extra fields per entry, which
/// is what makes authoring one the same act as saving one: build the setup in
/// the app, save it, export it, and `yarn example:add` merges it in. A preset
/// written by hand is the `audioSubdivisions` trap in CLAUDE.md -- a `val` that
/// is not what its `inputText` parses to -- and nothing here would catch it.
export type Example = {
  id: string;
  name: string;
  description: string;
  /** What to go and do with it. Shown until something is changed. */
  tryThis?: string;
  preset: Preset;
};

type RawEntry = { id?: string; description?: string; tryThis?: string };

// Run through the ordinary preset parser rather than trusted as written, so an
// example bundled today keeps loading after a key is renamed or a shape
// changes: it gets `migrateRust`, `migrateViews` and `pickKnownKeys` exactly
// as a saved preset does.
const parsed = parsePresetFile(JSON.stringify(rawFile));

// The two teaching fields are not part of a preset and `parsePresetFile` drops
// them, so they are read back off the raw entry by id.
const notes = new Map<string, RawEntry>(
  ((rawFile as unknown as { presets: RawEntry[] }).presets ?? [])
    .filter((e) => typeof e.id === "string")
    .map((e) => [e.id as string, e])
);

if (parsed.error || parsed.skipped)
  // A bundled file is a build-time artifact, so this is a developer's problem
  // rather than a user's -- but silence would be the `set_config` failure all
  // over again.
  console.error(
    "examples.json:",
    parsed.error ?? `${parsed.skipped} entries could not be read`
  );

export const EXAMPLES: Example[] = parsed.presets.map((p) => ({
  id: p.id,
  name: p.name,
  description: notes.get(p.id)?.description ?? "",
  tryThis: notes.get(p.id)?.tryThis || undefined,
  preset: { rust: p.rust, js: p.js },
}));
