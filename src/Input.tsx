import { useState } from "react";
import { Config, ConfigKey, NumberExpr, NumberListExpr } from "./config";
import {
  Params,
  evaluate,
  formatNumberList,
  parseNumberList,
} from "./expression";
import parser1 from "./parser1";
import parser2 from "./parser2";

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
  invalid ? { border: "1px solid #f55", outline: "none" } : {};

const asText = { toString: (x: unknown) => x as string };

interface InputProps<T extends ConfigKey> {
  label: string;
  _key: T;
  get: (key: ConfigKey) => Config[T];
  set: (key: ConfigKey, val: Config[T]) => void;
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
};

const LIST_HINT =
  'comma separated; "1x2, 2, 3x2" means 1 1 2 3 3. Parameters and arithmetic allowed: "bar/n x n"';

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
        title={'comma separated; "1x2, 2, 3x2" means 1 1 2 3 3'}
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
        title={LIST_HINT}
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
}: {
  label: string;
  _key: ConfigKey;
  set: (key: ConfigKey, val: NumberExpr) => void;
  params: Params;
  val: NumberExpr;
}) => {
  const [props, setFocusedVal] = useFocusedValue(val.inputText, asText);
  const invalid = !accepts(() => evaluate(props.value, params));
  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            set(_key, { inputText: v, val: evaluate(v, params) });
          } catch (e) {}
        }}
        title={'a number, or arithmetic over the parameters: "bar/n"'}
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
}: {
  label: string;
  _key: ConfigKey;
  get: any;
  set: any;
  parser: any;
  val: any;
}) => {
  const [props, setFocusedVal] = useFocusedValue(val.inputText, asText);

  return (
    <div style={rowStyle}>
      <label>{label}</label>
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            const g = parser.parse(v);
            set(_key, { ...val, val: g, inputText: v });
          } catch (e) {}
        }}
        style={{ width: "8em" }}
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

// Expression-backed fields carry no `type`, which is what tells them apart from
// a rhythm; whether the resolved value is an array picks the widget.
const isExprField = (val: any) =>
  typeof val?.inputText === "string" && val.val !== undefined;

// @ts-ignore
export const Input = (props: InputProps) => {
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
