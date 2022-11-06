import { useState } from "react";
import {
	Config,
  ConfigKey,
} from "./config";

const NumberArrayInput = ({
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

const BooleanInput = ({
  label,
  _key,
  get,
  set,
}: {
  label: string;
  _key: ConfigKey;
  get: (key: ConfigKey) => boolean;
  set: (key: ConfigKey, val: boolean) => void;
}) => (
  <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
    <label>{label}</label>
    <input
      onChange={(e) => set(_key, !get(_key))}
      type="checkbox"
      checked={Boolean(get(_key))}
    />
  </div>
);

const NumberInput = ({
  label,
  _key,
  get,
  set,
}: {
  label: string;
  _key: ConfigKey;
  get: (key: ConfigKey) => number;
  set: (key: ConfigKey, val: number) => void;
}) => (
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

interface InputProps<T extends ConfigKey> {
  label: string;
  _key: T;
  get: (key: ConfigKey) => Config[T];
  set: (key: ConfigKey, val: number) => void;
}

// @ts-ignore
export const Input = (props) => {
  const { _key, get } = props;
  const valueType = typeof get(_key);
  if (valueType === "boolean") return <BooleanInput {...props} />;
  else if (valueType === "number") return <NumberInput {...props} />;
  else if (valueType === "object") return <NumberArrayInput {...props} />;
  else return <div>error</div>;
};
