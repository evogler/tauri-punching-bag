import { Parameter, parameterText, resolveParameters } from "./config";
import { isValidParameterName } from "./expression";
import { invalidBorder, useFocusedValue } from "./Input";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
  flexWrap: "wrap",
};

// Offered in order to new parameters. `n` and `bar` first because they're the
// pair the whole feature was designed around -- `bar/n x n` rows against a
// `{n/bar}:1` grid.
const NAMES = ["n", "bar", "m", "k", "a", "b", "c", "d"];

const nextName = (parameters: Parameter[]) => {
  const taken = parameters.map((p) => p.name);
  const free = NAMES.find((n) => !taken.includes(n));
  if (free) return free;
  let i = 1;
  while (taken.includes(`p${i}`)) i++;
  return `p${i}`;
};

const ParameterRow = ({
  parameter,
  others,
  accepts,
  failure,
  onChange,
  onRemove,
}: {
  parameter: Parameter;
  others: string[];
  /** Whether this text would resolve, given every *other* parameter. */
  accepts: (text: string) => boolean;
  /** Why the committed value doesn't resolve, if it doesn't. */
  failure?: string;
  onChange: (next: Parameter) => void;
  onRemove: () => void;
}) => {
  const [nameProps, setNameText] = useFocusedValue(parameter.name, {
    toString: (x) => x as string,
  });
  const [valueProps, setValueText] = useFocusedValue(parameterText(parameter), {
    toString: (x) => x as string,
  });
  // A name that isn't an identifier, or is already in use, simply doesn't
  // commit -- so the expressions that refer to the old one keep working while
  // it's being retyped.
  const nameOk = (name: string) =>
    isValidParameterName(name) && !others.includes(name);

  return (
    <div style={rowStyle}>
      <input
        {...nameProps}
        onChange={(e) => {
          const name = e.target.value;
          setNameText(name);
          if (nameOk(name)) onChange({ ...parameter, name });
        }}
        title="Name to write in expressions. Letters, digits and underscore; x, min, max and round are taken"
        style={{ width: "5em", ...invalidBorder(!nameOk(nameProps.value)) }}
      />
      <span style={{ color: "#aaa" }}>=</span>
      <input
        {...valueProps}
        onChange={(e) => {
          const inputText = e.target.value;
          setValueText(inputText);
          // Committed only when it resolves *in place* -- which is what stops a
          // cycle being stored at all, rather than being stored and then
          // reported. `value` is left alone so the last good one survives.
          if (accepts(inputText)) onChange({ ...parameter, inputText });
        }}
        title={`Value of ${parameter.name}. A number, a list like ".6,.4", or an expression over the other parameters`}
        style={{
          width: "7em",
          ...invalidBorder(!accepts(valueProps.value)),
        }}
      />
      <button onClick={onRemove} title={`Remove ${parameter.name}`}>
        ✕
      </button>
      {failure && (
        <span style={{ color: "#e86", fontSize: "0.8em" }}>{failure}</span>
      )}
    </div>
  );
};

// The named numbers every pane's expressions can reference. Renaming one does
// not rewrite the expressions that use it: they go red and keep their last good
// value until they're pointed at the new name.
export const ParameterList = ({
  parameters,
  setParameters,
}: {
  parameters: Parameter[];
  setParameters: (next: Parameter[]) => void;
}) => {
  // Parameters may refer to each other in any order, so long as the references
  // form a DAG. A candidate list is resolved on every keystroke to decide
  // whether the text can be committed -- cheap, and it means a cycle is
  // rejected where it is typed rather than stored and reported afterwards.
  const { failed } = resolveParameters(parameters);
  const acceptsFor = (i: number) => (inputText: string) => {
    const candidate = parameters.map((p, j) =>
      j === i ? { ...p, inputText } : p
    );
    return !(candidate[i].name in resolveParameters(candidate).failed);
  };
  return (
  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
    {parameters.map((parameter, i) => (
      <ParameterRow
        key={i}
        parameter={parameter}
        accepts={acceptsFor(i)}
        failure={failed[parameter.name]}
        others={parameters.filter((_, j) => j !== i).map((p) => p.name)}
        onChange={(next) =>
          setParameters(parameters.map((p, j) => (j === i ? next : p)))
        }
        onRemove={() => setParameters(parameters.filter((_, j) => j !== i))}
      />
    ))}
    <div style={rowStyle}>
      <button
        onClick={() =>
          setParameters([...parameters, { name: nextName(parameters), value: 1 }])
        }
        title="Add a named number expressions can refer to"
      >
        + ADD PARAMETER
      </button>
      {!parameters.length && (
        <span style={{ color: "#aaa", fontSize: "0.8em" }}>
          None -- fields hold plain numbers. With n = 16, bar = 4, rows can say
          "bar/n x n" and a grid "&#123;n/bar&#125;:1".
        </span>
      )}
    </div>
  </div>
  );
};
