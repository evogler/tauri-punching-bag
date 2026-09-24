import {
  Parameter,
  isRandomParameter,
  parameterText,
  resolveParameters,
  rollParameters,
} from "./config";
import { formatNumberList, isValidParameterName } from "./expression";
import { useHelp } from "./help";
import { invalidBorder, useFocusedValue } from "./Input";
import { ui } from "./theme";

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

// What a parameter currently *is*, for a row whose text doesn't already say --
// a roll, an expression over other parameters, or a list written in a shorthand
// like ".6,.4x3". Shown against the text rather than against a flag, so any
// field whose text reads as its own value stays uncluttered.
const showValue = (value: number | number[] | undefined): string =>
  value === undefined
    ? "?"
    : Array.isArray(value)
    ? formatNumberList(value)
    : String(Number(value.toPrecision(6)));

const ParameterRow = ({
  parameter,
  others,
  accepts,
  failure,
  onChange,
  onReroll,
  onRemove,
}: {
  parameter: Parameter;
  others: string[];
  /** Whether this text would resolve, given every *other* parameter. */
  accepts: (text: string) => boolean;
  /** Why the committed value doesn't resolve, if it doesn't. */
  failure?: string;
  onChange: (next: Parameter) => void;
  onReroll: () => void;
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
  const random = isRandomParameter(parameter);
  const resolved = showValue(parameter.value);
  // A failed parameter contributes *nothing* downstream, so showing its last
  // good value beside the error would claim something that isn't true. The
  // error takes the slot instead.
  const showsValue = !failure && resolved !== parameterText(parameter);
  const help = useHelp();

  return (
    <div style={rowStyle}>
      <input
        {...nameProps}
        onChange={(e) => {
          const name = e.target.value;
          setNameText(name);
          if (nameOk(name)) onChange({ ...parameter, name });
        }}
        {...help("parameters.name")}
        style={{ width: "5em", ...invalidBorder(!nameOk(nameProps.value)) }}
      />
      <span style={{ color: ui.text.muted }}>=</span>
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
        {...help("parameters.value")}
        style={{
          width: "7em",
          ...invalidBorder(!accepts(valueProps.value)),
        }}
      />
      {random && (
        <button
          onClick={onReroll}
          title={`Reroll ${parameter.name}`}
          {...help("parameters.reroll")}
        >
          🎲
        </button>
      )}
      {showsValue && (
        <span
          style={{ color: ui.text.muted }}
          title={`What ${parameter.name} currently resolves to`}
        >
          = {resolved}
        </span>
      )}
      <button onClick={onRemove} title={`Remove ${parameter.name}`}>
        ✕
      </button>
      {failure && (
        <span style={{ color: ui.bad, fontSize: "0.8em" }}>{failure}</span>
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
  reroll,
}: {
  parameters: Parameter[];
  setParameters: (next: Parameter[]) => void;
  /** Re-rolls the randoms `pick` names; every random when it is omitted. */
  reroll: (pick?: (name: string) => boolean) => void;
}) => {
  // Parameters may refer to each other in any order, so long as the references
  // form a DAG. A candidate list is resolved on every keystroke to decide
  // whether the text can be committed -- cheap, and it means a cycle is
  // rejected where it is typed rather than stored and reported afterwards.
  const { failed } = resolveParameters(parameters);
  // Rolling everything here is what makes a half-typed `choose(1,2` red: a
  // random's stored value stands in for its text everywhere else, so nothing
  // would otherwise ever try to parse it.
  const rollAll = () => true;
  const acceptsFor = (i: number) => (inputText: string) => {
    const candidate = parameters.map((p, j) =>
      j === i ? { ...p, inputText } : p
    );
    return !(candidate[i].name in resolveParameters(candidate, rollAll).failed);
  };
  // Committing a roll's text has to roll it, or the row would sit there showing
  // whatever the parameter happened to be before -- a number that need not even
  // be one of the choices.
  const commit = (i: number, next: Parameter) =>
    setParameters(
      rollParameters(
        parameters.map((p, j) => (j === i ? next : p)),
        (name) =>
          name === next.name && parameterText(next) !== parameterText(parameters[i])
      )
    );
  const anyRandom = parameters.some(isRandomParameter);
  const help = useHelp();
  return (
  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
    {parameters.map((parameter, i) => (
      <ParameterRow
        key={i}
        parameter={parameter}
        accepts={acceptsFor(i)}
        failure={failed[parameter.name]}
        others={parameters.filter((_, j) => j !== i).map((p) => p.name)}
        onChange={(next) => commit(i, next)}
        onReroll={() => reroll((name) => name === parameter.name)}
        onRemove={() => setParameters(parameters.filter((_, j) => j !== i))}
      />
    ))}
    <div style={rowStyle}>
      <button
        onClick={() =>
          setParameters([...parameters, { name: nextName(parameters), value: 1 }])
        }
        {...help("parameters.add")}
      >
        Add parameter
      </button>
      {anyRandom && (
        <button onClick={() => reroll()} {...help("parameters.rerollAll")}>
          🎲 Reroll all (⌘R)
        </button>
      )}
      {!parameters.length && (
        <span style={{ color: ui.text.muted, fontSize: "0.8em" }}>
          None -- fields hold plain numbers. With n = 16, bar = 4, rows can say
          "bar/n x n" and a grid "&#123;n/bar&#125;:1".
        </span>
      )}
    </div>
  </div>
  );
};
