# Presets: storage, import and export

The long version of what CLAUDE.md summarises. Written as a spec on
2026-09-13 and kept as the reference once built.

## Where they live

`presets.json` in the app config dir, beside `audio-prefs.json`
(`~/Library/Application Support/com.vogler.dev/`). That directory is the
precedent: reachable from Finder's *Go to Folder*, legible by hand, and
already holding a file people are expected to be able to look at.

- **The session stays in localStorage.** It is written on every config change
  -- every keystroke in a text field -- and has no business being a file. This
  is deliberate, not an oversight to tidy up later.
- **The old store is left in place.** Migration reads `tpb.presets.v1` and
  writes `presets.json`; it does not clear the original. The cost is a stale
  copy nobody reads, and the cost of the alternative is somebody's presets when
  anything about the move goes wrong -- including running an older build.
  Migration runs once, when `presets.json` does not exist yet.
- **Writes are atomic**: to `presets.json.tmp`, then renamed. The file is now
  the only copy, so a half-written one is unaffordable in a way
  `audio-prefs.json` never was.
- **File IO goes through Rust commands, not the `fs` API.** The allowlist scopes
  `fs` to `$RESOURCE/*`, and the paths here come from a native dialog. Reading
  a user-chosen path is exactly what `load_drum_sample` and `set_mp3_buffer`
  already do.

## The format

One format for the store and for an exported file, so import has one parser and
"export everything" and "export this one" differ only in how many entries they
carry.

```json
{
  "format": "tauri-punching-bag presets",
  "version": 1,
  "app": "0.2.1",
  "exported": "2026-09-13T18:22:04.000Z",
  "presets": [
    {
      "id": "k3f9a1c2b7d4",
      "name": "16ths against the grid",
      "created": "2026-09-13T18:04:11.000Z",
      "lastUsed": "2026-09-13T18:20:55.000Z",
      "rust": { },
      "js": { }
    }
  ]
}
```

- **An array with the name as a property**, not a map keyed by name. A map had
  nowhere to put per-preset metadata, and the metadata is what the sort orders
  and the duplicate detection are built on.
- **`version` exists from the first file written.** A format with no version
  has nothing for a migration to key off, and this codebase has been bitten by
  redefining a shape in place more than once (`loopFeedback`, `beatsPerRow`).
- **Duplicate names *within* one file are now representable**, which a map made
  impossible. Import treats the second as a collision with the first, through
  the same path as a collision with something already saved.
- **`app` and `exported` are for the human** reading a file a friend sent a
  year ago. Nothing reads them.

## Identity: an id, and a hash that is never stored

Two different questions, and they want different answers.

- **`id` is stable across edits**: this is the same preset, changed. Generated
  at save time, carried through export and import, and the only thing that can
  say "you already have an older version of this".
- **The content hash is stable across renames**: these are the same settings
  under different names. Computed from the preset with the metadata stripped.

**The hash is computed, never stored.** A stored hash is wrong the moment a
preset is edited, and a derived value that can go stale is the `val` trap the
config rules already warn about at length. It also has to **canonicalise key
order** before hashing -- a config built fresh and one restored from JSON have
their keys in different orders and would otherwise never match.

The three cases an import row can be in, in the order they are tested:

| Match | Note shown | Checked by default | On confirm |
|---|---|---|---|
| same `id` | updates "*name*" | yes | replaces in place, keeping `created` |
| same hash | identical to "*name*" | **no** | suffixed like any collision |
| same name | renamed to "*name* (1)" | yes | suffixed |
| nothing | — | yes | added |

Suffixing increments past what is taken: `(1)`, then `(2)`. This is what keeps
re-importing your own edited preset from growing a pile of `groove (1)` …
`groove (7)` with no way to tell which is current -- the `id` match catches it
first and offers to replace.

## Corruption

Two cases that point in opposite directions, which is why they are handled
differently.

- **A corrupt import file is refused.** Nothing is added.
- **A corrupt entry inside an otherwise good import file is skipped, not
  fatal.** Nine readable presets out of ten are shown and importable; the tenth
  is listed as unusable and cannot be checked. Refusing the whole file over one
  hand-edited entry is the worse outcome.
- **A corrupt `presets.json` is moved aside, never replaced.** Refusing it
  leaves the app with no presets, and the next save then writes an empty store
  over the only copy. It is renamed to `presets.corrupt-<timestamp>.json` and
  the panel says so.

## Order

`name` ascending by default. `created` and `lastUsed` are in the file, so
*newest* and *recently used* are available and cost nothing. `lastUsed` is
stamped when a preset is loaded.

Which order is chosen is plain React state, not a config key -- transient UI,
the same call the panel tabs made.

## The dialogs

One component serves both, because partial loading will want the same shape: a
list of presets with checkboxes, a note column, and the action buttons passed
in.

- **Import**: pick a file, review what is in it with the notes above, confirm.
  The primary button is *import*; when exactly one row is checked a secondary
  *import and load* appears beside it. A checkbox that only means something in
  one case is clutter, and always loading a single import would be wrong --
  importing one to keep for later is an ordinary thing to do.
- **Manage**: the same list over what is saved, with *export selected* and
  *delete selected*. This is where "export one", "export some" and "export all"
  all live, so there is one place rather than three buttons.
- **Import adds; it does not load.** Stated because it reads as obvious right
  up until someone implements it the other way.
- **You export saved presets, not what is on screen.** Save first. One concept.

Export filenames default to `<name>.json` for one and
`punching-bag-presets-<date>.json` for several.

## What a preset cannot carry

`bufferCompensation` is already excluded (`LOCAL_RUST_KEYS`), so an exported
file is machine-clean without doing anything. What is *not* clean is paths:

- **`filePath`** is a plain js key, so every preset carries an absolute path to
  a backing track.
- **A drum voice's `path`** is a built-in name (`"ride"`, which travels) or an
  absolute path to a sample (which does not).

Neither breaks the config push -- `load_drum_sample` and `set_mp3_buffer`
return `Result`, so a missing file is a failed command rather than a rejected
`set_config`, and `sampleStatus` already tracks `loading`/`ok`/`error` per
voice. What was missing is only that the panel never said *which* file it could
not find.

- **A missing file shows its full path**, not `drumLabel`'s basename. The
  basename is the right thing everywhere else and the wrong thing here: the
  question a missing file raises is *where did it look*, which is the half
  `drumLabel` strips.

### Not built, deliberately

- **Named drum sounds, and kits.** A voice would name a role (`kick`) and a
  machine-local kit would map roles to files -- the same split the config,
  `audio-prefs.json` and `LOCAL_RUST_KEYS` already make three times over. It
  removes the drum half of the path problem entirely rather than reporting on
  it, and it is the missing half of something already half-built: parser2 parses
  sound letters per note and nothing reads them. Wants a default kit shipped
  with the app, which is an asset question rather than a code one. `sound?`
  would go *alongside* `path`, never replacing it.
- **Bundling the referenced audio.** Decided to wait for kits, because kits
  change what it means: once drums resolve through a kit there are no drum
  references left in a preset, and the only thing left to bundle is the backing
  track -- the one file that is big, personal, and least appropriate to put in
  a file you hand to someone. If it is built anyway it needs a container rather
  than one JSON, relative references inside it, and imported media copied into
  an app-managed folder, since a bundle opened from Downloads may not be there
  tomorrow. That is a fourth store.
- **Loading only part of a preset** (the drums, or the visuals). Wanted soon.
  **Parts are a load-time filter, never a storage shape** -- if "export just the
  drums" became saveable there would be two kinds of preset file and import
  would have to handle both. The file stays whole; the load dialog gains
  checkboxes, in the same component the import review already uses.
