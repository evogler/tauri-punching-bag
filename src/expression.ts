// Arithmetic over named parameters, so a config field can be written `bar/n x n`
// instead of `0.25 x 16` and one parameter reshapes several settings at once.
// Deliberately not a scripting language: numbers, parameter names, `+ - * / ( )`
// and min/max/round, and nothing else.
//
// Everything here throws rather than returning NaN or a partial result. Callers
// use the throw to decide between committing a new value and keeping the last
// good one -- a silent NaN would reach the draw loop as a blank pane.

// A parameter is a number, or a list of them. A list is only meaningful where a
// list is expected -- `rows: divs x 4` -- so every scalar context rejects one
// by name rather than coercing it to something arbitrary.
export type Params = Record<string, number | number[]>;

export type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

const NUMBER = /^(?:\d+\.?\d*|\.\d+)/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  round: (args) => {
    if (args.length !== 1) throw new Error("round takes one argument");
    return Math.round(args[0]);
  },
};

// Names the substitution would eat or that would shadow something. `x` is the
// repeat separator in a number list; the function names would shadow the calls;
// and h/k/r/s are parser2's sound letters, which `substituteParams` would
// otherwise replace with a number inside a rhythm. Rejecting them where a
// parameter is named is the only place a user can hit any of this.
const RHYTHM_SOUNDS = ["h", "k", "r", "s"];

// The parameter names an expression mentions. Used to tell a circular
// reference from a merely unknown one, which are the same failure to an
// evaluator and completely different things to fix.
export const referencedNames = (text: string): string[] => {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const t of tokens) {
    if (t.kind !== "name") continue;
    if (t.value === "x" || t.value in FUNCTIONS) continue;
    names.push(t.value);
  }
  return names;
};

export const isValidParameterName = (name: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
  !(name in FUNCTIONS) &&
  !RHYTHM_SOUNDS.includes(name.toLowerCase()) &&
  !/^[xX](\d|$)/.test(name);

export const tokenize = (text: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ("+-*/(),[]".includes(c)) {
      out.push({ kind: "op", value: c });
      i++;
      continue;
    }
    const rest = text.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      out.push({ kind: "num", value: parseFloat(num[0]) });
      i += num[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      // `0.25x16` carries no spaces around the separator -- formatNumberList
      // writes it that way -- so `x16` has to come apart here rather than being
      // read as one identifier. Unambiguous because `x` is reserved.
      if (/^[xX]\d/.test(name[0])) {
        out.push({ kind: "name", value: "x" });
        i += 1;
        continue;
      }
      out.push({
        kind: "name",
        value: name[0] === "X" ? "x" : name[0],
      });
      i += name[0].length;
      continue;
    }
    throw new Error(`unexpected character "${c}"`);
  }
  return out;
};

export const evaluateTokens = (tokens: Token[], params: Params): number => {
  let i = 0;
  const eat = (op: string) => {
    const t = tokens[i];
    if (t && t.kind === "op" && t.value === op) {
      i++;
      return true;
    }
    return false;
  };
  const expect = (op: string) => {
    if (!eat(op)) throw new Error(`expected "${op}"`);
  };

  const expr = (): number => {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  };

  const term = (): number => {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) {
        const d = unary();
        // `n = 0` is one backspace away from `n = 16`, so this is a live case
        // during a parameter edit, not a theoretical one.
        if (d === 0) throw new Error("division by zero");
        v /= d;
      } else return v;
    }
  };

  const unary = (): number => {
    if (eat("-")) return -unary();
    if (eat("+")) return unary();
    return primary();
  };

  const primary = (): number => {
    const t = tokens[i];
    if (!t) throw new Error("unexpected end of expression");
    if (t.kind === "num") {
      i++;
      return t.value;
    }
    if (t.kind === "op") {
      if (t.value !== "(") throw new Error(`unexpected "${t.value}"`);
      i++;
      const v = expr();
      expect(")");
      return v;
    }
    i++;
    const fn = FUNCTIONS[t.value];
    if (fn) {
      expect("(");
      const args = [expr()];
      while (eat(",")) args.push(expr());
      expect(")");
      return fn(args);
    }
    if (!(t.value in params)) throw new Error(`unknown parameter "${t.value}"`);
    const raw = params[t.value];
    // A list parameter in a scalar position. Saying so beats silently taking
    // the first element or the length, either of which would be a guess.
    if (Array.isArray(raw)) throw new Error(`"${t.value}" is a list`);
    const v = raw;
    if (!Number.isFinite(v)) throw new Error(`parameter "${t.value}" is not a number`);
    return v;
  };

  const value = expr();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i].value}"`);
  if (!Number.isFinite(value)) throw new Error("not a finite number");
  return value;
};

export const evaluate = (text: string, params: Params): number =>
  evaluateTokens(tokenize(text), params);

// Both the entry separator and the repeat separator have to be found at paren
// depth zero: `min(n,4) x 2` has a comma that belongs to the call, not the list.
const splitTop = (
  tokens: Token[],
  isSeparator: (t: Token) => boolean
): Token[][] => {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "op" && (t.value === "(" || t.value === "[")) depth++;
    else if (t.kind === "op" && (t.value === ")" || t.value === "]")) depth--;
    if (depth === 0 && isSeparator(t)) parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts;
};

// A run of identical values can be written "3x2" instead of "3,3". Kept well
// below anything useful as a row count, so a fat-fingered "3x1000" is rejected
// rather than building a list big enough to stall the draw loop.
export const MAX_LIST_LENGTH = 128;

// Throws rather than returning something partial, so text that isn't a valid
// list yet leaves the last good value in place.
export const parseNumberList = (
  text: string,
  params: Params = {}
): number[] => {
  const out = parseTokenList(tokenize(text), params);
  // An empty list would divide by zero downstream, so treat it as unfinished
  // typing instead of committing it.
  if (!out.length) throw new Error("empty list");
  return out;
};

// What sits to the left of an `x`: a bracketed group, a list parameter, or an
// ordinary expression. Groups nest, since the body is parsed by the same rules.
const groupTokens = (tokens: Token[], params: Params): number[] => {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const bracketed =
    tokens.length >= 2 &&
    first.kind === "op" &&
    first.value === "[" &&
    last.kind === "op" &&
    last.value === "]";
  if (bracketed) {
    const inner = parseTokenList(tokens.slice(1, -1), params);
    if (!inner.length) throw new Error("empty group");
    return inner;
  }
  // A bare list parameter: `divs x 4`. Only when it is the whole entry --
  // `divs*2` is arithmetic on a list and has no meaning here.
  if (tokens.length === 1 && first.kind === "name") {
    const value = params[first.value];
    if (Array.isArray(value)) {
      if (!value.length) throw new Error(`"${first.value}" is empty`);
      return value.slice();
    }
  }
  return [evaluateTokens(tokens, params)];
};

// The one list parser, used for a whole field and for the body of a group --
// which is what makes `[[.6,.4]x2, 1]x3` work without a second set of rules.
const parseTokenList = (tokens: Token[], params: Params): number[] => {
  const out: number[] = [];
  for (const entry of splitTop(
    tokens,
    (t) => t.kind === "op" && t.value === ","
  )) {
    if (!entry.length) continue;
    const [valueTokens, countTokens, ...extra] = splitTop(
      entry,
      (t) => t.kind === "name" && t.value === "x"
    );
    if (extra.length) throw new Error('only one "x" per entry');
    // The repeated thing is a *group*, not always a single number: `[.6,.4]x8`
    // and a list parameter both stand where a number used to. One number is
    // just the one-element case, so there is a single path here.
    const group = groupTokens(valueTokens, params);
    // A repeat has to be whole, and a parameter sweep hands us 3.5 on the way
    // past. Rounding keeps the field usable mid-sweep, where rejecting would
    // flash it red for every intermediate value.
    const count =
      countTokens === undefined
        ? 1
        : Math.round(evaluateTokens(countTokens, params));
    if (!(count >= 0)) throw new Error("negative repeat count");
    if (out.length + count * group.length > MAX_LIST_LENGTH)
      throw new Error("list too long");
    for (let i = 0; i < count; i++) out.push(...group);
  }
  return out;
};

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

// Float error would otherwise reach the rhythm parser as 0.30000000000000004,
// which parses fine but makes any error about it unreadable.
const formatValue = (n: number) => String(Number(n.toPrecision(12)));

export const hasInterpolation = (text: string) => text.includes("{");

// Rhythm text goes through the generated PEG parsers, so an expression is
// substituted for its value *before* parsing rather than by touching the
// grammar. Braced because rhythm text already has syntax of its own to collide
// with: `{n/bar}:1` becomes `4:1`.
// Both rhythm grammars already do arithmetic on numbers -- `1/5` parses to a
// span of 0.2, `2*3` to 6, and they reserve `+ - * / ( ) [ ]` for it. So a
// rhythm doesn't need an expression language bolted on: swapping each parameter
// name for its value and letting the grammar evaluate the result is enough, and
// it means no braces. Identifiers that aren't parameters are left alone, which
// is what keeps parser2's sound letters working.
export const substituteParams = (text: string, params: Params): string =>
  text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) =>
    name in params ? formatParam(params[name]) : name
  );

// A list substitutes as `0.6,0.4`, which is exactly a group body in both rhythm
// grammars -- so `[divs]:1` works. Anywhere else it will fail to parse, which
// shows up as the field going red with its last good value kept.
const formatParam = (value: number | number[]): string =>
  Array.isArray(value) ? value.map(formatValue).join(",") : formatValue(value);

// What a rhythm field runs before parsing. Braces are still honoured first, for
// `min`/`max`/`round` -- the grammars have no functions of their own.
export const resolveRhythmText = (text: string, params: Params): string =>
  substituteParams(interpolate(text, params), params);

export const interpolate = (text: string, params: Params): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) return out + text.slice(i);
    const close = text.indexOf("}", open);
    if (close === -1) throw new Error("unclosed {");
    out +=
      text.slice(i, open) +
      formatValue(evaluate(text.slice(open + 1, close), params));
    i = close + 1;
  }
  return out;
};
