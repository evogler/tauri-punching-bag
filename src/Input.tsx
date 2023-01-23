import { useRef, useState } from "react";
import { Config, ConfigKey } from "./config";
import parser1 from "./parser1";
import parser2 from "./parser2";

const useFocusedValue = (
  val: unknown,
  { toString }: { toString?: (val: unknown) => string } = {
    toString: undefined,
  }
) => {
  const _toString = toString ?? JSON.stringify;
  const [isFocused, setIsFocused] = useState(false);
  const [focusedVal, setFocusedVal] = useState<string>(_toString(val));
  const onFocus = () => setIsFocused(true);
  const onBlur = () => setIsFocused(false);
  const value = isFocused ? focusedVal : _toString(val);
  console.log(val, _toString(val), toString, JSON.stringify(val), value);
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

const NumberArrayInput = ({ label, _key, get, set }: II<number[]>) => {
  const [props, setFocusedVal] = useFocusedValue(get(_key), {
    toString: (val) => (val as unknown[]).join(","),
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
            const g = v.split(",").map(parseFloat);
            set(_key, g);
          } catch (e) {}
        }}
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
