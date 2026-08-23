import { useRef, useState } from "react";
import { Config, ConfigKey } from "./config";
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

// A run of identical values can be written "3x2" instead of "3,3". Kept well
// below anything useful as a row count, so a fat-fingered "3x1000" is rejected
// rather than building a list big enough to stall the draw loop.
const MAX_LIST_LENGTH = 128;

const ENTRY = /^(-?(?:\d+\.?\d*|\.\d+))(?:\s*x\s*(\d+))?$/i;

// Throws rather than returning something partial, so text that isn't a valid
// list yet leaves the last good value in place.
export const parseNumberList = (text: string): number[] => {
  const out: number[] = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const match = ENTRY.exec(entry);
    if (!match) throw new Error(`not a number or count: "${entry}"`);
    const value = parseFloat(match[1]);
    const count = match[2] === undefined ? 1 : parseInt(match[2], 10);
    if (out.length + count > MAX_LIST_LENGTH) throw new Error("list too long");
    for (let i = 0; i < count; i++) out.push(value);
  }
  // An empty list would divide by zero downstream, so treat it as unfinished
  // typing instead of committing it.
  if (!out.length) throw new Error("empty list");
  return out;
};

// Writes runs back out in the "3x2" shorthand, so what you typed survives a
// round trip through the expanded array.
export const formatNumberList = (values: number[]): string => {
  const parts: string[] = [];
  let i = 0;
  while (i < values.length) {
    let run = 1;
    while (i + run < values.length && values[i + run] === values[i]) run++;
    parts.push(run > 1 ? `${values[i]}x${run}` : `${values[i]}`);
    i += run;
  }
  return parts.join(",");
};

const NumberArrayInput = ({ label, _key, get, set }: II<number[]>) => {
  const [props, setFocusedVal] = useFocusedValue(get(_key), {
    toString: (val) => formatNumberList(val as number[]),
  });
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
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
        style={{ width: "8em" }}
      ></input>
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
  const [props, setFocusedVal] = useFocusedValue(val.inputText, {
    toString: (x) => x as string,
  });

  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
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
  <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
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
    <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
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
