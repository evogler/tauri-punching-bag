import {
  Parameter,
  ParameterScene,
  sceneInEffect,
  snapshotParameters,
} from "./config";
import { useHelp } from "./help";
import { ui } from "./theme";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

/// The key that recalls scene `i`, or nothing past the tenth. ⌘1 first and ⌘0
/// tenth, the same count the section rail used before it moved to ⌘⌥.
export const sceneAccelerator = (i: number): string | undefined =>
  i < 0 || i > 9 ? undefined : String((i + 1) % 10);

/// Which scene a digit recalls. The inverse of `sceneAccelerator`.
export const sceneForDigit = (digit: string): number => (Number(digit) + 9) % 10;

// What a scene holds, in one line: the values, not the names of the settings,
// the rule `Group` summaries follow.
const summary = (scene: ParameterScene) =>
  scene.parameters.map((p) => `${p.name}=${p.inputText ?? p.value}`).join("  ");

// Snapshots of the parameters, recalled with ⌘ and a digit. Saving copies
// every parameter as it stands; *Update* overwrites a scene with the current
// values, which is how one is edited -- set the parameters, then update.
export const SceneList = ({
  scenes,
  parameters,
  setScenes,
  recall,
}: {
  scenes: ParameterScene[];
  parameters: Parameter[];
  setScenes: (next: ParameterScene[]) => void;
  recall: (i: number) => void;
}) => {
  const help = useHelp();
  const replace = (i: number, next: ParameterScene) =>
    setScenes(scenes.map((s, j) => (j === i ? next : s)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {scenes.map((scene, i) => {
        const key = sceneAccelerator(i);
        const active = sceneInEffect(parameters, scene);
        return (
          // Wraps on a phone, the summary taking the line below (`.lane`).
          <div key={i} style={rowStyle} className="lane" {...help("parameters.scene")}>
            <span
              className="key-hint"
              style={{
                width: "2em",
                color: ui.text.muted,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {key ? `⌘${key}` : ""}
            </span>
            <input
              value={scene.name}
              onChange={(e) => replace(i, { ...scene, name: e.target.value })}
              className="lane-fill"
              style={{
                width: "7em",
                // Which scene the parameters currently match, if any. A mark
                // on the field rather than colour alone on the text.
                borderColor: active ? ui.accent : undefined,
              }}
            />
            <button
              onClick={() => recall(i)}
              style={{
                backgroundColor: active ? ui.surface.selected : undefined,
              }}
            >
              Recall
            </button>
            <button
              onClick={() =>
                replace(i, { ...scene, parameters: snapshotParameters(parameters) })
              }
              {...help("parameters.sceneUpdate")}
            >
              Update
            </button>
            <button
              onClick={() => setScenes(scenes.filter((_, j) => j !== i))}
              title={`Remove ${scene.name}`}
            >
              ✕
            </button>
            <span
              title={summary(scene)}
              className="lane-field"
              style={{
                color: ui.text.muted,
                fontSize: "0.8em",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                flex: 1,
              }}
            >
              {summary(scene)}
            </span>
          </div>
        );
      })}
      <div style={rowStyle}>
        <button
          disabled={!parameters.length}
          onClick={() =>
            setScenes([
              ...scenes,
              {
                name: `scene ${scenes.length + 1}`,
                parameters: snapshotParameters(parameters),
              },
            ])
          }
          {...help("parameters.sceneSave")}
        >
          Save as scene
        </button>
        {!scenes.length && (
          <span style={{ color: ui.text.muted, fontSize: "0.8em" }}>
            {parameters.length
              ? "None yet -- save the parameters as they are, then recall with ⌘1."
              : "Add a parameter first."}
          </span>
        )}
      </div>
    </div>
  );
};
