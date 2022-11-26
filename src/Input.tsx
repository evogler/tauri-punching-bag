import { useRef, useState } from "react";
import { Config, ConfigKey } from "./config";
import parser from "./parser";

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
}

const NumberArrayInput = ({ label, _key, get, set }: II<number[]>) => {
  const [isFocused, setIsFocused] = useState(false);
  const [focusedVal, setFocusedVal] = useState(get(_key).join(","));
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
      <label>{label}</label>
      <input
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            const g = v.split(",").map(parseFloat);
            set(_key, g);
          } catch (e) {}
        }}
        value={isFocused ? focusedVal : get(_key).join(", ")}
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
}: {
  label: string;
  _key: ConfigKey;
  get: any;
  set: any;
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [focusedVal, setFocusedVal] = useState(get(_key).val.join(","));
	const renderCount = useRef(0);
	renderCount.current += 1;

  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
			<span>{renderCount.current}</span>
      <label>{label}</label>
      <input
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            // const g = v.split(",").map(parseFloat);
            const g = parser.parse(v);
            set(_key, { type: "parser", val: g });
          } catch (e) {}
        }}
        value={isFocused ? focusedVal : get(_key).val.join(", ")}
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

const NumberInput = ({ label, _key, get, set }: II<number>) => (
  <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
    <label>{label}</label>
    <input
      onChange={(e) => {
        const val = parseFloat(e.target.value);
        if (!val) return;
        set(_key, val);
      }}
      value={get(_key)}
      style={{ width: "4em" }}
    />
  </div>
);

// @ts-ignore
export const Input = (props: InputProps) => {
  const { _key, get } = props;
  const val = get(_key);
  const valueType = Array.isArray(val) ? "array" : typeof val;
  try {
    switch (valueType) {
      case "object": {
        if (val.type === "parser") {
          return <ParserArrayInput {...props} />;
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
