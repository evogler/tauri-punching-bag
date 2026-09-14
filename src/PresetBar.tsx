import { useEffect, useState } from "react";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/api/dialog";
import { getVersion } from "@tauri-apps/api/app";
import {
  Preset,
  StoredPreset,
  defaultPreset,
  formatPresetFile,
  loadStore,
  makeStored,
  parsePresetFile,
  presetHash,
  readPresetFileAt,
  saveStore,
  uniqueName,
  writePresetFileAt,
} from "./presets";
import { DialogRow, PresetDialog } from "./PresetDialog";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

const SORTS = {
  name: "a–z",
  created: "newest",
  used: "recent",
} as const;
type Sort = keyof typeof SORTS;

const stamp = () => new Date().toISOString();

// What an incoming preset will do to the store, decided before anything is
// written so the review list can say it. See docs/presets.md for the order the
// three cases are tested in and why.
export type Plan = {
  key: string;
  preset: StoredPreset;
  kind: "new" | "update" | "duplicate" | "rename";
  targetId?: string;
  row: DialogRow;
};

export const planImport = (incoming: StoredPreset[], store: StoredPreset[]): Plan[] => {
  const taken = new Set(store.map((p) => p.name));
  const byId = new Map(store.map((p) => [p.id, p]));
  const byHash = new Map(store.map((p) => [presetHash(p), p]));
  return incoming.map((preset, i) => {
    const key = String(i);
    // Same id first: an edited version of something you already have is the
    // one case where a suffix would be exactly the wrong answer.
    const updates = byId.get(preset.id);
    if (updates)
      return {
        key,
        preset,
        kind: "update",
        targetId: updates.id,
        row: {
          key,
          name: preset.name,
          note: `updates "${updates.name}"`,
          noteColor: "#8cf",
        },
      };
    const same = byHash.get(presetHash(preset));
    if (same)
      return {
        key,
        preset,
        kind: "duplicate",
        row: { key, name: preset.name, note: `identical to "${same.name}"` },
      };
    if (taken.has(preset.name)) {
      const renamed = uniqueName(preset.name, taken);
      taken.add(renamed);
      return {
        key,
        preset,
        kind: "rename",
        row: {
          key,
          name: preset.name,
          note: `saved as "${renamed}"`,
          noteColor: "#fc8",
        },
      };
    }
    taken.add(preset.name);
    return { key, preset, kind: "new", row: { key, name: preset.name } };
  });
};

type Dialog =
  | { kind: "import"; plans: Plan[]; skipped: number }
  | { kind: "manage" };

export const PresetBar = ({
  getCurrent,
  onLoad,
}: {
  getCurrent: () => Preset;
  onLoad: (preset: Preset) => void;
}) => {
  const [presets, setPresets] = useState<StoredPreset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [note, setNote] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [appVersion, setAppVersion] = useState("");

  // The store is a file now, so reading it is async -- unlike localStorage,
  // which could be a useState initialiser.
  useEffect(() => {
    loadStore().then(({ presets, note }) => {
      setPresets(presets);
      if (note) setNote(note);
    });
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const update = async (next: StoredPreset[]) => {
    setPresets(next);
    setNote(await saveStore(next));
  };

  const sorted = [...presets].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "created") return (b.created ?? "").localeCompare(a.created ?? "");
    return (b.lastUsed ?? b.created ?? "").localeCompare(
      a.lastUsed ?? a.created ?? ""
    );
  });
  const selected = presets.find((p) => p.id === selectedId);

  // So SAVE always does something, even before anything has been typed.
  const nextDefaultName = () => {
    let i = 1;
    const taken = new Set(presets.map((p) => p.name));
    while (taken.has(`config ${i}`)) i++;
    return `config ${i}`;
  };

  const save = () => {
    const trimmed = name.trim() || nextDefaultName();
    const existing = presets.find((p) => p.name === trimmed);
    if (existing && !window.confirm(`Overwrite "${trimmed}"?`)) return;
    const current = getCurrent();
    if (existing) {
      update(
        presets.map((p) =>
          p.id === existing.id ? { ...p, ...current, lastUsed: stamp() } : p
        )
      );
      setSelectedId(existing.id);
    } else {
      const added = makeStored(trimmed, current);
      update([...presets, added]);
      setSelectedId(added.id);
    }
    setName(trimmed);
  };

  const load = (preset: StoredPreset) => {
    onLoad({ rust: preset.rust, js: preset.js });
    update(
      presets.map((p) => (p.id === preset.id ? { ...p, lastUsed: stamp() } : p))
    );
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.name}"?`)) return;
    update(presets.filter((p) => p.id !== selected.id));
    setSelectedId("");
  };

  const openDialog = (next: Dialog, preChecked: string[]) => {
    setChecked(preChecked);
    setDialog(next);
  };

  const beginImport = async () => {
    try {
      const path = await openFileDialog({
        multiple: false,
        filters: [{ name: "presets", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const parsed = parsePresetFile(await readPresetFileAt(path));
      if (parsed.error) {
        setNote(`couldn't import that file: ${parsed.error}`);
        return;
      }
      if (!parsed.presets.length) {
        setNote("no presets in that file");
        return;
      }
      const plans = planImport(parsed.presets, presets);
      openDialog(
        { kind: "import", plans, skipped: parsed.skipped },
        // Everything but the ones you already have, byte for byte.
        plans.filter((p) => p.kind !== "duplicate").map((p) => p.key)
      );
    } catch (e) {
      setNote(`couldn't import: ${e}`);
    }
  };

  const applyImport = (keys: string[], alsoLoad: boolean) => {
    if (dialog?.kind !== "import") return;
    const chosen = dialog.plans.filter((p) => keys.includes(p.key));
    let next = [...presets];
    let last: StoredPreset | null = null;
    for (const plan of chosen) {
      if (plan.kind === "update" && plan.targetId) {
        // The file's name wins -- it is an update of that preset, renames and
        // all -- but still cannot collide with something else.
        const id = plan.targetId;
        const others = next.filter((p) => p.id !== id).map((p) => p.name);
        const merged = {
          ...plan.preset,
          id,
          created: next.find((p) => p.id === id)?.created ?? plan.preset.created,
          name: uniqueName(plan.preset.name, others),
        };
        next = next.map((p) => (p.id === id ? merged : p));
        last = merged;
      } else {
        // Recomputed here rather than trusting the note: what is free depends
        // on which rows were actually checked.
        const added = {
          ...plan.preset,
          name: uniqueName(plan.preset.name, next.map((p) => p.name)),
        };
        next = [...next, added];
        last = added;
      }
    }
    update(next);
    setDialog(null);
    if (last) {
      setSelectedId(last.id);
      setName(last.name);
      if (alsoLoad) onLoad({ rust: last.rust, js: last.js });
    }
  };

  const doExport = async (ids: string[]) => {
    const chosen = presets.filter((p) => ids.includes(p.id));
    if (!chosen.length) return;
    try {
      const path = await saveFileDialog({
        defaultPath:
          chosen.length === 1
            ? `${chosen[0].name.replace(/[/\\:]/g, "-")}.json`
            : `punching-bag-presets-${stamp().slice(0, 10)}.json`,
        filters: [{ name: "presets", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await writePresetFileAt(path, formatPresetFile(chosen, appVersion));
      setNote(`exported ${chosen.length} to ${path}`);
      setDialog(null);
    } catch (e) {
      setNote(`couldn't export: ${e}`);
    }
  };

  const doDelete = (ids: string[]) => {
    if (!window.confirm(`Delete ${ids.length} preset${ids.length > 1 ? "s" : ""}?`))
      return;
    update(presets.filter((p) => !ids.includes(p.id)));
    if (ids.includes(selectedId)) setSelectedId("");
    setDialog(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={rowStyle}>
        <select
          value={selectedId}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setName(presets.find((p) => p.id === e.target.value)?.name ?? "");
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">
            {presets.length ? "-- pick a config --" : "-- no saved configs --"}
          </option>
          {sorted.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          title="Order the list by name, when it was saved, or when it was last used"
        >
          {Object.entries(SORTS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button
          onClick={() => selected && load(selected)}
          disabled={!selected}
          title={selected ? `Load "${selected.name}"` : "Pick a config first"}
        >
          LOAD
        </button>
        <button
          onClick={remove}
          disabled={!selected}
          title={selected ? `Delete "${selected.name}"` : "Pick a config first"}
        >
          DELETE
        </button>
      </div>
      <div style={rowStyle}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder={nextDefaultName()}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button onClick={save} title="Save the current settings">
          SAVE
        </button>
        <button
          onClick={() => onLoad(defaultPreset())}
          title="Reset every setting to its default"
        >
          DEFAULTS
        </button>
      </div>
      <div style={rowStyle}>
        <button onClick={beginImport} title="Add presets from a file">
          import…
        </button>
        <button
          onClick={() =>
            openDialog({ kind: "manage" }, selected ? [selected.id] : [])
          }
          disabled={!presets.length}
          title="Export or delete several at once"
        >
          manage…
        </button>
      </div>
      {!presets.length && (
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          Name the current settings and hit SAVE.
        </div>
      )}
      {note && (
        <div style={{ color: "#fbb", fontSize: "0.8em" }}>{note}</div>
      )}

      {dialog?.kind === "import" && (
        <PresetDialog
          title="Import presets"
          hint={
            dialog.skipped
              ? `${dialog.skipped} entry in that file could not be read and is not listed.`
              : undefined
          }
          rows={dialog.plans.map((p) => p.row)}
          selected={checked}
          setSelected={setChecked}
          onClose={() => setDialog(null)}
          actions={[
            {
              label: "import",
              primary: true,
              run: (keys) => applyImport(keys, false),
            },
            {
              label: "import and load",
              // Only meaningful for one, and a checkbox that means something in
              // exactly one case is clutter.
              hidden: checked.length !== 1,
              run: (keys) => applyImport(keys, true),
            },
          ]}
        />
      )}

      {dialog?.kind === "manage" && (
        <PresetDialog
          title="Your presets"
          hint="Export the ones you pick to a file, or delete them."
          rows={sorted.map((p) => ({
            key: p.id,
            name: p.name,
            note: (p.lastUsed ?? p.created ?? "").slice(0, 10),
          }))}
          selected={checked}
          setSelected={setChecked}
          onClose={() => setDialog(null)}
          actions={[
            { label: "export selected", primary: true, run: doExport },
            { label: "delete selected", run: doDelete },
          ]}
        />
      )}
    </div>
  );
};
