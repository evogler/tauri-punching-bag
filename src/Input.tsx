import { useState } from "react";
import { Config, ConfigKey, NumberExpr, NumberListExpr } from "./config";
import { useHelp } from "./help";
import {
  Params,
  evaluate,
  formatNumberList,
  parseNumberList,
  resolveRhythmText,
} from "./expression";
import parser1 from "./parser1";
import parser2 from "./parser2";
import { ui } from "./theme";

// While the field has focus it shows exactly what was typed, so half-finished
// text that doesn't parse yet survives instead of being overwritten by the last
// value that did parse.
export const useFocusedValue = (
  val: unknown,
  { toString }: { toString?: (val: unknown) => string } = {
    toString: undefined,
  }
) => {
  const _toString = toString ?? JSON.stringify;
  const [isFocused, setIsFocused] = useState(false);
  const [focusedVal, setFocusedVal] = useState<string>(_toString(val));
  const onFocus = () => {
    // Start from what's on screen now, not from whatever was typed last time
    // the field had focus.
    setFocusedVal(_toString(val));
    setIsFocused(true);
  };
  const onBlur = () => setIsFocused(false);
  const value = isFocused ? focusedVal : _toString(val);
  return [{ onFocus, onBlur, value }, setFocusedVal] as const;
};

// Recomputed from whatever is on screen rather than remembered from the last
// keystroke, so a field also goes red when a parameter change breaks an
// expression that was perfectly good when it was typed.
export const accepts = (parse: () => unknown) => {
  try {
    parse();
    return true;
  } catch (e) {
    return false;
  }
};

// Silently keeping the last good value reads as the field ignoring you, so an
// unparseable field says so. The last good value does stay in effect.
export const invalidBorder = (invalid: boolean): React.CSSProperties =>
  invalid ? { border: `1px solid ${ui.error}`, outline: "none" } : {};

const asText = { toString: (x: unknown) => x as string };

interface InputProps<T extends ConfigKey> {
  label: string;
  _key: T;
  get: (key: ConfigKey) => Config[T];
  set: (key: ConfigKey, val: Config[T]) => void;
  // Which help entry pointing at the row shows. Defaults to the key.
  help?: string;
}

interface II<T> {
  label: string;
  _key: ConfigKey;
  get: (key: ConfigKey) => T;
  set: (key: ConfigKey, val: T) => void;
  validate?: (val: T) => boolean;
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  // Centred rather than stretched, so a label sits against the middle of its
  // own field instead of the top of it. Invisible in a dense list and very
  // visible in the top bar, which is 42px tall and holds one of these.
  alignItems: "center",
};

const NumberArrayInput = ({ label, _key, get, set }: II<number[]>) => {
  const [props, setFocusedVal] = useFocusedValue(get(_key), {
    toString: (val) => formatNumberList(val as number[]),
  });
  const invalid = !accepts(() => parseNumberList(props.value));
  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            set(_key, parseNumberList(v));
          } catch (e) {}
        }}
        style={{ width: "8em", ...invalidBorder(invalid) }}
      ></input>
    </div>
  );
};

// A list written over the parameters. Stored as {inputText, val} so the text
// survives a parameter change that its value doesn't -- the number the draw
// code reads is re-derived by resolveJsConfig, never by this component.
const ExprListInput = ({
  label,
  _key,
  set,
  params,
  val,
}: {
  label: string;
  _key: ConfigKey;
  set: (key: ConfigKey, val: NumberListExpr) => void;
  params: Params;
  val: NumberListExpr;
}) => {
  const [props, setFocusedVal] = useFocusedValue(val.inputText, asText);
  const invalid = !accepts(() => parseNumberList(props.value, params));
  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            set(_key, { inputText: v, val: parseNumberList(v, params) });
          } catch (e) {}
        }}
        style={{ width: "8em", ...invalidBorder(invalid) }}
      ></input>
    </div>
  );
};

const ExprNumberInput = ({
  label,
  _key,
  set,
  params,
  val,
  validate,
}: {
  label: string;
  _key: ConfigKey;
  set: (key: ConfigKey, val: NumberExpr) => void;
  params: Params;
  val: NumberExpr;
  validate?: (n: number) => boolean;
}) => {
  const [props, setFocusedVal] = useFocusedValue(val.inputText, asText);
  // A validator failing is treated like a syntax error -- red, and not applied.
  // `resolveNumber` enforces the same rule when a parameter changes, which is
  // the path this component can't see.
  const parse = (text: string) => {
    const n = evaluate(text, params);
    if (validate && !validate(n)) throw new Error("out of range");
    return n;
  };
  const invalid = !accepts(() => parse(props.value));
  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            set(_key, { inputText: v, val: parse(v) });
          } catch (e) {}
        }}
        style={{ width: "6em", ...invalidBorder(invalid) }}
      />
    </div>
  );
};

const ParserArrayInput = ({
  label,
  _key,
  get,
  set,
  parser = parser1,
  val,
  params,
}: {
  label: string;
  _key: ConfigKey;
  get: any;
  set: any;
  parser: any;
  val: any;
  params?: Params;
}) => {
  const [props, setFocusedVal] = useFocusedValue(val.inputText, asText);
  // The grammars already do arithmetic on numbers, so a parameter only has to
  // become its value before parsing -- no braces, and no expression syntax of
  // our own competing with the rhythm notation.
  const parse = (text: string) =>
    parser.parse(resolveRhythmText(text, params ?? {}));
  const invalid = !accepts(() => parse(props.value));

  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            set(_key, { ...val, val: parse(v), inputText: v });
          } catch (e) {}
        }}
        style={{ width: "8em", ...invalidBorder(invalid) }}
      ></input>
    </div>
  );
};

const BooleanInput = ({ label, _key, get, set }: II<boolean>) => (
  <div style={rowStyle}>
    <label>{label}</label>
    <input
      onChange={(e) => set(_key, !get(_key))}
      type="checkbox"
      checked={Boolean(get(_key))}
    />
  </div>
);

const NumberInput = ({ label, _key, get, set, validate }: II<number>) => {
  const [props, setFocusedVal] = useFocusedValue(get(_key));

  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          setFocusedVal(e.target.value);
          const val = parseFloat(e.target.value);
          if (isNaN(val)) return;
          if (validate && !validate(val)) return;
          set(_key, val);
        }}
        style={{ width: "4em" }}
      />
    </div>
  );
};

// A single color, as a swatch. Deliberately *not* wired into the type dispatch
// below: `filePath` is a string too, so "every string is a color" would be
// wrong the moment anything else took one. Called by name instead, the way
// Slider and RowColorList are.
export const ColorInput = ({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
  help: string;
}) => {
  const showHelp = useHelp();
  return (
    <div style={{ ...rowStyle, alignItems: "center" }} {...showHelp(help)}>
      <label>{label}</label>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "2em",
          height: "1.6em",
          padding: 0,
          border: "none",
          background: "none",
        }}
      />
      <span style={{ color: ui.text.muted, fontSize: "0.8em" }}>{value}</span>
    </div>
  );
};

// A plain string field. Deliberately outside the type dispatch below for the
// same reason ColorInput is: `filePath` is a string too, so "every string is a
// name" would be wrong the moment anything else took one. There is no parse and
// so nothing to keep half-typed -- every keystroke is already a valid value.
export const TextInput = ({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  help: string;
}) => {
  const showHelp = useHelp();
  return (
    <div style={rowStyle} {...showHelp(help)}>
      <label>{label}</label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "8em" }}
      />
    </div>
  );
};

// Expression-backed fields carry no `type`, which is what tells them apart from
// a rhythm; whether the resolved value is an array picks the widget.
const isExprField = (val: any) =>
  typeof val?.inputText === "string" && val.val !== undefined;

// Every row names its help entry -- its key, unless told otherwise -- so a
// field gains a description just by one existing in helpText.ts.
// @ts-ignore
export const Input = (props: InputProps) => {
  const help = useHelp();
  return (
    <div {...help((props as any).help ?? props._key)}>{renderInput(props)}</div>
  );
};

const renderInput = (props: any) => {
  const { _key, get } = props;
  const val = get(_key);
  const valueType = Array.isArray(val) ? "array" : typeof val;
  try {
    switch (valueType) {
      case "object": {
        if (val.type === "parser1") {
          return <ParserArrayInput {...{ ...props, parser: parser1, val }} />;
        } else if (val.type === "parser2") {
          return <ParserArrayInput {...{ ...props, parser: parser2, val }} />;
        } else if (isExprField(val)) {
          const p = { ...props, val, params: (props as any).params ?? {} };
          return Array.isArray(val.val) ? (
            <ExprListInput {...p} />
          ) : (
            <ExprNumberInput {...p} />
          );
        } else {
          throw new Error("Unknown object type");
        }
      }
      case "boolean": {
        return <BooleanInput {...props} />;
      }
      case "number": {
        return <NumberInput {...props} />;
      }
      case "array": {
        return <NumberArrayInput {...props} />;
      }
      default: {
        throw new Error("Unknown value type");
      }
    }
  } catch (e) {
    return <div>error: {JSON.stringify(e)} </div>;
  }
};
