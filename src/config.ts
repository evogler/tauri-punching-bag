import parser1 from "./parser1";
import parser2 from "./parser2";
import {
  Params,
  evaluate,
  formatNumberList,
  referencedNames,
  resolveRhythmText,
  parseNumberList,
  isRandomText,
  MAX_LIST_LENGTH,
  Rng,
} from "./expression";

// How a single input channel is drawn.
export type ChannelStyle = { color: string; alpha: number };

// Channel 0 keeps the old grey so a one-input setup looks exactly as it did.
export const CHANNEL_COLORS = [
  "#cccccc",
  "#ff5533",
  "#33cc66",
  "#ffcc00",
  "#cc66ff",
  "#00ddcc",
  "#ff66aa",
  "#aaff33",
];

// Styles are stored sparsely -- an untouched channel has no entry and falls back
// to the palette, so the list doesn't have to be sized to the device up front.
export const channelStyle = (
  styles: ChannelStyle[],
  index: number
): ChannelStyle =>
  styles[index] ?? {
    color: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
    alpha: 1,
  };

// A drum sound with its own rhythm. `path` is either a built-in name or the
// absolute path the file was loaded from -- the same key Rust files it under.
export type DrumVoice = {
  path: string;
  on: boolean;
  volume: number;
  /// Milliseconds to start the sample early, so its transient lands on the beat
  /// however far into the file the attack actually sits.
  offset: number;
  /// Beats to push this part later in the cycle, so parts don't all land on
  /// one. Optional because voices saved before it existed don't carry it -- read
  /// it through drumShift rather than directly.
  shift?: number;
  /// Gain multipliers applied per hit, cycled by hit index and multiplied with
  /// `volume`. Length is independent of the rhythm's, so a list that doesn't
  /// divide evenly drifts in and out of phase with it. Optional for the same
  /// reason as `shift` -- read it through drumGains.
  ///
  /// Expression-backed, unlike `offset` and `shift`: `resolveRustConfig` walks
  /// it, so a parameter change re-resolves it rather than leaving `val` stale
  /// in the one config nothing on this side re-reads. The bare-array branch is
  /// what a session written before that looks like.
  gains?: NumberListExpr | number[];
  /// Probability that each hit sounds, cycled by hit index the same way `gains`
  /// is -- so the two stay in phase. A hit that loses the roll keeps its slot;
  /// only the sample is dropped. Empty or absent means every hit sounds, which
  /// is what a voice saved before this existed reads as. Expression-backed, so
  /// it is in `resolveRustConfig`'s walk alongside the gains.
  chances?: NumberListExpr | number[];
  rhythm: Rhythm;
};

// One stretch of the practice cycle: how long it lasts and what sounds during
// it. A count-off is a section, a groove is a section, a pause is a section
// with nothing on -- and the retired `clickToggle` was two of them.
//
// Deliberately holds nothing else. The moment a section carries its own tempo
// or its own grid this is a DAW; everything else stays global and is varied
// through the parameters, which is the surface that actually makes it
// interesting.
export type Section = {
  on: boolean;
  // Expression-backed, and `resolveRustConfig` walks it -- so `bar*16` is four
  // bars of groove, and a count-off can be `bar` whatever `bar` becomes.
  beats: NumberExpr;
  click: boolean;
  // Whether this stretch is drawn. Off, no samples are stamped for it, so the
  // cursor holds still through a count-off and the pane's timeline starts where
  // the playing does. Optional, so a section written before this loads
  // unchanged -- the same treatment `VisualGrid.alpha` gets.
  show?: boolean;
  // Which drum voices sound, by index, the same convention a pane's `channels`
  // uses. So a count-off is an ordinary voice with its own rhythm, and nothing
  // here needs a rhythm or a sound of its own.
  drums: number[];
};

export const sectionShown = (section: Section) => section.show !== false;

// One cell of a drum grid: how likely that column is to sound, and how loud.
//
// **Unchecked is a chance of 0**, not a separate flag. That is what the
// compilation forces rather than a tidiness choice: parser2 has notes and spans
// and no rests, so a column with no hit still has to emit a note, and a note
// that never sounds is exactly a chance of 0. Keeping "off" and "chance 0"
// apart would be a distinction the compiler could not express -- and the hits
// view is then the chance view rounded to {0, 1}, which is one state rather
// than two that have to agree.
//
// `gain` is absent until somebody sets one, which is the whole of what lets a
// grid leave a hand-typed `gains` list alone. The second pass's gains and
// chances lenses write these two fields and need no migration.
export type GridCell = {
  /** 0..1. Anything above 0 draws as checked. */
  chance: number;
  gain?: number;
};

export type DrumGridRow = {
  // Index into the Rust config's `drums`, the way `sections[].drums` names its
  // voices. The weakest part of the design -- deleting a voice shifts every
  // index after it, so the deletion has to fix these up -- but a stable voice
  // id is a wider change than this feature.
  voice: number;
  // One per column of the grid as drawn, not per emitted column: the pattern
  // tiles across the passes, so the extra copies are the compiler's business.
  cells: GridCell[];
};

// An editing surface for a drum part, in the js config because nothing in it
// reaches the audio thread. What it compiles *to* is the Rust config's `drums`
// -- an ordinary rhythm, gains and chances, exactly as if they had been typed.
export type DrumGrid = {
  // A length in columns, not in beats. The beats follow from the pulse.
  columns: number;
  // A number or a list, in `parseNumberList` syntax like `beatsPerRow` -- so
  // `bar/n` follows a parameter and `[.6,.4]x2` is a group. Deliberately *not*
  // the rhythm grammar: those are two different `x` operators and a grid wants
  // the number-list one. Expression-backed, which it may only be because
  // `resolveJsConfig` walks it.
  pulse: NumberListExpr | number[];
  // Reset the pulse at the grid boundary, so every pass is identical. Off, the
  // pulse keeps running across the boundary and the pattern only comes back
  // round after `pulse.length / gcd(columns, pulse.length)` passes. Optional so
  // a hand-written preset that omits it gets the default rather than its
  // opposite -- the treatment `Section.show` already has.
  restart?: boolean;
  rows: DrumGridRow[];
};

export const gridRestart = (grid: DrumGrid) => grid.restart !== false;

// What the pulse field shows: the text as typed where there is one, so `bar/n`
// survives a render instead of being reformatted into its current numbers. The
// array branch is a hand-written preset, as it is for the drum gains.
export const gridPulseText = (grid: DrumGrid): string =>
  Array.isArray(grid.pulse)
    ? formatNumberList(grid.pulse)
    : grid.pulse.inputText;

export const cellOn = (cell?: GridCell) => (cell?.chance ?? 0) > 0;

// Which voice each grid row writes, and whether the grid owns that voice's
// gains. One place decides both, so the compile and the read-only fields in the
// drums tab can never disagree about who owns what.
//
// The *first* grid to name a voice owns it: the same sound in two grids is
// meant to be two voices, and silently compiling one voice twice would make the
// later grid look broken instead of the arrangement.
export type GridOwner = { grid: number; row: number; gains: boolean };

export const gridOwners = (grids: DrumGrid[]): Map<number, GridOwner> => {
  const out = new Map<number, GridOwner>();
  grids.forEach((grid, g) =>
    grid.rows.forEach((row, r) => {
      if (out.has(row.voice)) return;
      out.set(row.voice, {
        grid: g,
        row: r,
        gains: row.cells.some((c) => typeof c?.gain === "number"),
      });
    })
  );
  return out;
};

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// The grammars have no exponent form and no formatter for one, so a span is
// kept inside the range plain decimal covers. Anything outside it is a nonsense
// pulse anyway, and refusing is what leaves the last good rhythm in place.
const MIN_PULSE = 1e-6;
const MAX_PULSE = 1e6;

const rhythmNumber = (n: number) => String(Number(n.toPrecision(12)));

export type CompiledGrid = {
  /** How many times the pattern runs before the pulse comes back round. */
  passes: number;
  /** Columns as drawn -- one pass's worth. */
  columns: number;
  /** Columns emitted: `columns * passes`. */
  emitted: number;
  /** The span of every emitted column, in beats. */
  spans: number[];
  beats: number;
  rhythm: Rhythm;
};

/**
 * Every column becomes a note, and the whole phasing period is written out.
 *
 * There is no way to say "the pulse keeps running" in a rhythm that repeats on
 * one pass, and nothing in the audio thread is going to learn about grids -- so
 * the emitted rhythm covers `columns * passes` columns and the checkboxes tile
 * across it.
 *
 * Throws rather than returning something partial, the same contract
 * `parseNumberList` has: a grid that cannot be compiled leaves the voices it
 * owns exactly as they were, which is the last good rhythm.
 */
export const compileGrid = (grid: DrumGrid): CompiledGrid => {
  const columns = Math.round(grid.columns);
  if (!(columns >= 1)) throw new Error("a grid needs at least one column");
  const pulse = exprList(grid.pulse);
  if (!pulse.length) throw new Error("the pulse is empty");
  for (const n of pulse)
    if (!Number.isFinite(n) || n < MIN_PULSE || n > MAX_PULSE)
      throw new Error("every pulse length has to be a positive number of beats");
  // Restart only changes the pass count: column `i` takes `pulse[i % length]`
  // either way, and with one pass that is the pulse resetting at the boundary.
  const passes = gridRestart(grid) ? 1 : pulse.length / gcd(columns, pulse.length);
  const emitted = columns * passes;
  if (emitted > MAX_LIST_LENGTH)
    throw new Error(
      `${columns} columns against a ${pulse.length}-long pulse is ${emitted} columns, past the limit of ${MAX_LIST_LENGTH}`
    );
  const spans = Array.from({ length: emitted }, (_, i) => pulse[i % pulse.length]);
  // A run of identical spans is written as a repeated group rather than as
  // `0.25,0.25,...` a hundred times over, because this text is what the
  // read-only rhythm field shows. Both forms parse to the same notes.
  const allSame = spans.every((s) => s === spans[0]);
  const inputText =
    allSame && spans.length > 1
      ? `[${rhythmNumber(spans[0])}]x${spans.length}`
      : spans.map(rhythmNumber).join(",");
  const rhythm: Rhythm = {
    inputText,
    val: parser2.parse(inputText),
    type: "parser2",
  };
  return {
    passes,
    columns,
    emitted,
    spans,
    beats: spans.reduce((a, b) => a + b, 0),
    rhythm,
  };
};

// The lists are one *pass* long, not one period: a hit index is reduced modulo
// the list's length, and the column count divides the emitted note count by
// construction, so a list of `columns` entries lands on exactly the column it
// was drawn in. That is the property the compilation was chosen for -- the hit
// count *is* the column count -- and writing the period out would only repeat
// itself.
const gridVoice = (
  voice: DrumVoice,
  compiled: CompiledGrid,
  row: DrumGridRow,
  owner: GridOwner
): DrumVoice => {
  const cells = row.cells;
  // A missing cell reads as unchecked. Only a hand-edited config can have one
  // -- the panel keeps the list the length of the column count -- and no hit is
  // the safer reading of "no state saved for this column".
  const chances = Array.from({ length: compiled.columns }, (_, i) =>
    Math.min(1, Math.max(0, cells[i]?.chance ?? 0))
  );
  const gains = owner.gains
    ? Array.from({ length: compiled.columns }, (_, i) => cells[i]?.gain ?? 1)
    : null;
  const chancesText = formatNumberList(chances);
  const gainsText = gains ? formatNumberList(gains) : "";
  // Compared by text because every part of this is derived from it: the same
  // text parses to the same notes, so an unchanged text is an unchanged voice.
  // Identity is what the caller's fixed point is built on.
  if (
    voice.rhythm.type === "parser2" &&
    voice.rhythm.inputText === compiled.rhythm.inputText &&
    voice.chances !== undefined &&
    drumChancesText(voice) === chancesText &&
    (!gains || drumGainsText(voice) === gainsText)
  )
    return voice;
  return {
    ...voice,
    rhythm: compiled.rhythm,
    chances: { inputText: chancesText, val: chances },
    ...(gains ? { gains: { inputText: gainsText, val: gains } } : {}),
  };
};

/**
 * Rewrites every gridded voice's rhythm and chances from its grid.
 *
 * Returns the *same array* when nothing changed, which is what lets the caller
 * push its own output back without looping: the compile is a pure function of
 * the grids and the voices, so re-applying it is a fixed point.
 */
export const applyDrumGrids = (
  drums: DrumVoice[],
  grids: DrumGrid[]
): DrumVoice[] => {
  if (!grids.length) return drums;
  const owners = gridOwners(grids);
  const compiled = new Map<number, CompiledGrid>();
  let out: DrumVoice[] | null = null;
  // `forEach` rather than `for...of` over the map: the build targets es5, where
  // iterating one needs downlevelIteration.
  owners.forEach((owner, voice) => {
    const current = drums[voice];
    if (!current) return;
    if (!compiled.has(owner.grid)) {
      try {
        compiled.set(owner.grid, compileGrid(grids[owner.grid]));
      } catch (e) {
        // A grid that cannot be compiled leaves its voices exactly as they
        // were, which is the last good rhythm -- the same answer a syntax
        // error in a field gives.
        return;
      }
    }
    const plan = compiled.get(owner.grid);
    if (!plan) return;
    const next = gridVoice(
      current,
      plan,
      grids[owner.grid].rows[owner.row],
      owner
    );
    if (next === current) return;
    out = out ?? drums.slice();
    out[voice] = next;
  });
  return out ?? drums;
};

// Deleting a voice shifts every index after it, and a grid row naming a voice
// by index is exactly the `sections[].drums` problem. Rows pointing at the
// deleted voice go; rows after it come down one.
export const removeGridVoice = (grids: DrumGrid[], voice: number): DrumGrid[] =>
  grids.map((grid) => ({
    ...grid,
    rows: grid.rows
      .filter((r) => r.voice !== voice)
      .map((r) => (r.voice > voice ? { ...r, voice: r.voice - 1 } : r)),
  }));



export const sectionBeats = (section: Section) =>
  exprNumber(section.beats);

// What one section costs, and what the whole cycle does. Both here rather than
// in the panel because the section list and the cycle readout want the same
// answer.
// The cycle expanded into the steps it actually plays: which section, and
// where in the cycle it starts. The one place the order is read, so the panel
// and the readout can't disagree about what is going to happen.
export const cycleSteps = (
  sections: Section[],
  order: NumberListExpr | number[] = []
): { section: number; from: number }[] => {
  const list = exprList(order);
  const steps: { section: number; from: number }[] = [];
  let total = 0;
  const indices = list.length
    ? // Wrapped rather than clamped, so deleting a section can't leave the
      // order pointing at nothing -- the rule rowColorFor already follows.
      list.map((n) =>
        sections.length
          ? (((Math.round(n) - 1) % sections.length) + sections.length) %
            sections.length
          : 0
      )
    : sections.map((_, i) => i);
  for (const i of indices) {
    const s = sections[i];
    if (!s || !s.on || !(sectionBeats(s) > 0)) continue;
    steps.push({ section: i, from: total });
    total += sectionBeats(s);
  }
  return steps;
};

export const cycleBeatsOf = (
  sections: Section[],
  order: NumberListExpr | number[] = []
) =>
  cycleSteps(sections, order).reduce(
    (total, step) => total + sectionBeats(sections[step.section]),
    0
  );

export const drumShift = (voice: DrumVoice) =>
  typeof voice.shift === "number" ? voice.shift : 0;

export const drumGains = (voice: DrumVoice) => {
  const vals = voice.gains ? exprList(voice.gains) : [];
  return vals.length ? vals : [1];
};

// What the field shows: the text as typed where there is one, so `bar/n x n`
// survives a render, and the formatted values otherwise.
export const drumGainsText = (voice: DrumVoice): string =>
  voice.gains && !Array.isArray(voice.gains)
    ? voice.gains.inputText
    : formatNumberList(drumGains(voice));

// Empty rather than `[1]`: no list means every hit sounds, and the audio thread
// reads the empty case as "no gate" rather than as a probability of 1. Both say
// the same thing, but only one of them survives being typed back to empty.
export const drumChances = (voice: DrumVoice): number[] =>
  voice.chances ? exprList(voice.chances) : [];

// Empty text for a voice that has no chances, so the field reads as unset
// rather than as a list somebody chose.
export const drumChancesText = (voice: DrumVoice): string =>
  voice.chances
    ? Array.isArray(voice.chances)
      ? formatNumberList(voice.chances)
      : voice.chances.inputText
    : "";

// A gains list saved before it took expressions. Wrapped rather than renamed,
// for the reason `normalizeView` wraps `beatsPerRow`: a rename would throw away
// every saved drum part.
export const normalizeGains = (
  gains: NumberListExpr | number[]
): NumberListExpr =>
  Array.isArray(gains)
    ? { inputText: formatNumberList(gains), val: gains }
    : gains;

// Chances wants exactly the same wrapping and for exactly the same reason, so
// it is the same function rather than a copy of it.
export const normalizeChances = normalizeGains;

// The built-in kit, as `samples/kit.json` describes it and Rust reports it.
// Module-level for the same reason as the sample rate: `drumLabel` is called
// from components that have no way to reach App's state. App re-renders when it
// arrives, which is what picks the names up.
export type KitSound = { id: string; name: string; file: string };
let kit: KitSound[] = [];
export const getKit = () => kit;
export const setKit = (next: KitSound[]) => {
  kit = next;
};

export const kitSound = (path: string) => kit.find((s) => s.id === path);

export const channelPan = (pans: number[], index: number) => pans[index] ?? 0;

// A per-channel trim on the pane's `visualGain`, so a quiet mic and a hot line
// can share a row. Sparse and 1 where unset, like the pans are 0.
export const channelGain = (gains: number[], index: number) => gains[index] ?? 1;

export const drumLabel = (path: string) =>
  kitSound(path)?.name ?? (path.split("/").pop() || path);

// `value` widened from `number` to also hold a list, so `divs = .6,.4` can be
// repeated as `divs x 4` in any number-list field. Widening rather than
// renaming is safe here in a way it is not for most keys: a saved session's
// plain number is still a valid value, so restore merges it over the default
// and nothing changes meaning.
export type Parameter = {
  name: string;
  /** The last value that resolved. Kept when `inputText` stops evaluating. */
  value: number | number[];
  /**
   * The expression as typed, when it is one. Absent means `value` is a literal.
   *
   * Optional rather than a required `{inputText, val}` pair so a session
   * written before parameters could reference each other still loads: its
   * `{ name, value: 4 }` is already a valid parameter and needs no migration.
   */
  inputText?: string;
};

// A field written as an expression over the parameters: the text typed, and the
// number it currently evaluates to. Same shape as `Rhythm`, so the recursive
// `unwrapValues` already strips it down to `val` on the way to Rust -- an
// expression-backed field costs nothing there if one ever moves across.
export type Expr<T> = { inputText: string; val: T };
export type NumberExpr = Expr<number>;
export type NumberListExpr = Expr<number[]>;

// The bare-value branches are the second line of defence behind
// `normalizeView`: restore merges saved values *over* the defaults, so a
// session written before these fields took expressions can put a plain number
// where an object is expected (the loopFeedback trap in CLAUDE.md).
export const exprNumber = (field: NumberExpr | number): number =>
  typeof field === "number" ? field : field?.val ?? 0;

export const exprList = (field: NumberListExpr | number[]): number[] =>
  Array.isArray(field) ? field : field?.val ?? [];

// Wraps a literal for a field that takes expressions. Defaults are written this
// way so the shape is uniform from the start; `normalizeRust`/`normalizeView`
// wrap the bare numbers that sessions written before it saved.
export const numExpr = (n: number): NumberExpr => ({
  inputText: String(n),
  val: n,
});

// Must match MAX_LOOP_ECHOES in src-tauri/src/constants.rs. Duplicated rather
// than plumbed across because it only guards the input here.
export const MAX_LOOP_ECHOES = 16;

// The rust-side fields that take expressions -- every numeric one that has a
// text input. The sliders and dropdowns keep plain numbers, having nowhere to
// type an expression.
export type RustExprKey =
  | "bpm"
  | "beatsToLoop"
  | "loopEchoes"
  | "loopEchoGain"
  | "clickVolume"
  | "clickShift"
  | "audioInGain"
  | "highPassHz"
  | "bufferCompensation"
  | "analysisBandLow"
  | "analysisBandHigh"
  | "onsetThreshold"
  | "onsetMinGap"
  | "onsetOffset"
  | "fileVolume"
  | "fileBeats"
  | "fileOffsetMs"
  | "fileShift"
  | "fileRepeatStart"
  | "fileRepeatEnd";

export const defaultRustConfig = {
	audioInGain: numExpr(1.0),
  // A high pass over the input, for the picture rather than the sound: the
  // waveform is drawn nearly raw at the zoom levels in use, so tilting it
  // toward the high end shows note starts instead of cycles of the
  // fundamental. See src-tauri/src/filter.rs for why it is two poles.
  highPassOn: false,
  highPassHz: numExpr(800),
  // Also filter what is heard -- the monitor and what the looper records -- so
  // the filter can be auditioned rather than only looked at.
  highPassAudio: false,
  // Discount the picture by what the app itself put through the speaker. For
  // practising on speakers, where the click and the drums come back in through
  // the microphone and draw bars of their own over the thing you are trying to
  // look at.
  //
  // A real subtraction, phase-accurate and sample by sample: it learns the
  // speaker -> microphone response from the click and takes the echo out,
  // leaving what was played underneath. No amount to set -- see bleed.rs.
  bleedCancelOn: false,
  // Follow the path as it moves: hands over a laptop keyboard are part of the
  // response, not a perturbation of it. Guarded so that the worst it can do is
  // stop following -- see bleed.rs.
  bleedTrackOn: true,
  // Take the bleed out of what is *sounded* too -- the monitor, and what the
  // looper records. The looper is the reason: on a laptop its own playback is
  // re-recorded through the microphone every pass, which is real acoustic
  // feedback and it builds. Separate switch, because it changes what the looper
  // records and that is not something to do unasked.
  bleedCancelAudioOn: false,
  // Require that no band of the loop gains energy. What survives cancelling the
  // bleed is one narrow range still at unity gain, which grows over minutes
  // while everything else decays -- an ordinary howl with a long time constant.
  // See src-tauri/src/loop_guard.rs.
  loopFeedbackGuardOn: false,
  audioMonitorOn: false,
  beatsToLoop: numExpr(4),
  // How many times a phrase comes back, one `beatsToLoop` apart each time.
  loopEchoes: numExpr(1),
  // Gain per echo, compounding: 1 keeps them all at full volume, below that the
  // run fades out. 0 silences everything after the first echo, so it is a gain,
  // not a "feedback amount" -- see the note in structs.rs on the rename.
  loopEchoGain: numExpr(1),
  // Alternate between recording and not, so a phrase comes back while you play
  // over it rather than being recorded over -- and, on speakers, the one thing
  // that breaks the microphone -> speaker -> microphone path by construction
  // instead of suppressing it. Standalone keys rather than a field on Section:
  // a section wrap restarts the beat and voids the loop buffer, and a record
  // cycle that has to run across those cannot be a section. Still open.
  loopRecordCycleOn: false,
  // The cycle in beats, alternating and starting *silent*: `32,16,16,16` is 32
  // off, 16 recording, 16 off, 16 recording. Same list syntax as sectionOrder,
  // so groups, repeats and parameters all work. An odd number of lengths is
  // walked twice, which is what makes a bare `4` the plain "4 off, 4 on".
  loopRecordCycle: { inputText: "4", val: [4] } as NumberListExpr,
  bpm: numExpr(91),
  bufferCompensation: numExpr(4330),
  // Whether Rust runs the spectrogram FFTs at all. Off costs nothing on the
  // audio thread and sends nothing, so a session with no spectrogram pane can
  // switch it off. Not derived from the panes: that would mean writing rust
  // config from a render, which is a loop waiting to happen.
  analysisOn: true,
  // The band the spectral flux is summed over, in Hz. Wide by default -- it
  // spans everything the bin edges cover -- so the curve starts as the whole
  // picture and gets narrowed onto whatever you're listening for. Nothing in
  // the frontend reads these; they exist to reach the audio thread.
  analysisBandLow: numExpr(30),
  analysisBandHigh: numExpr(16000),
  // FFT window in frames, trading frequency resolution against time
  // resolution. A plain number, not an expression: it's a dropdown over
  // ANALYSIS_WINDOWS, with nowhere to type one. The hop -- and so the
  // spectrogram's column width and how precisely the flux places an attack --
  // is always a quarter of it.
  analysisWindow: 1024,
  // How far above its local median the flux has to peak to count as an attack.
  // Relative, not absolute, so one number holds across dynamics.
  //
  // **0.4 is measured, not chosen.** It was 0.05, which came from a synthetic
  // tone -- a hard full-band onset reads 2.3 and a sustaining *sine* under
  // 0.01, so 0.05 looked safely between them. Real instruments are not sines:
  // over 61 seconds of isolated guitar notes, 0.05 reported **269 onsets for
  // 7 notes**, and a ride cymbal's own decay gave 21 for 3 hits. A guitar
  // attack measures 0.44-0.92 here and the loudest thing that is not one
  // measures 0.373, so there is a clean gap and this sits in it. See
  // `src-tauri/examples/onsets.rs` and the sweep in CLAUDE.md.
  onsetThreshold: numExpr(0.4),
  // Milliseconds an onset suppresses further ones on the same channel. A single
  // attack spreads over a few hops and the peak test alone reports the
  // shoulders of a broad one.
  onsetMinGap: numExpr(40),
  // Milliseconds to nudge every onset, positive later. A trim on top of the
  // structural correction in analysis.rs, which is measured on an instant
  // attack; a slow-attack instrument sits differently. Calibrate against the
  // drums bus, whose trigger times the callback knows exactly.
  onsetOffset: numExpr(0),
  paused: false,
  // Which channels the callback packs into the sample stream, by device channel
  // index. Derived from the panes rather than set directly -- see
  // `unionChannels`; a pane picks its own channels and this follows.
  visibleChannels: [0] as number[],
  // Stereo position per input channel, -1 hard left to 1 hard right. Sparse:
  // a channel with no entry sits centred.
  channelPans: [] as number[],
  clickOn: true,
  // The practice cycle. Off, everything sounds continuously.
  sectionsOn: false,
  sections: [] as Section[],
  // The cycle written out: 1-based section numbers, in the same list syntax as
  // beatsPerRow -- so `1, [2,3]x8` is a count-off and then eight passes of a
  // two-section groove. A *group* repeat, which is the one thing making a
  // section longer cannot express. Empty means the sections in order.
  sectionOrder: { inputText: "", val: [] as number[] } as NumberListExpr,
  clickVolume: numExpr(0.3),
  clickShift: numExpr(0),
  drumOn: true,
  loopingOn: false,
  playFile: true,
  // Output gain for the file. Everything else on the bus had one; the file was
  // summed in at unity, so balancing it against your playing meant the system
  // volume.
  fileVolume: numExpr(1),
  // How many beats the file is -- the whole of what makes it line up with the
  // grid. Above zero the read position is derived from the beat and so cannot
  // drift; 0 free-runs the file at its natural rate, locked to nothing.
  fileBeats: numExpr(0),
  // Mechanical nudge in ms, positive *earlier*, for a bounce whose downbeat
  // sits a little way into the file. Same sense as a drum voice's offset.
  fileOffsetMs: numExpr(0),
  // Musical rotation in beats: which beat the file's start lands on.
  // Tempo-independent, like a drum voice's shift.
  fileShift: numExpr(0),
  // A-B repeat: cycle over `fileRepeatStart`..`fileRepeatEnd` of the file, in
  // the file's own beats, instead of the whole of it. Needs `fileBeats` -- a
  // position in beats means nothing until the length in beats is declared. A
  // segment may cross the file's end (14..18 of 16 beats), which loops a pickup.
  // Render the file to fit `fileBeats` at the current tempo without moving its
  // pitch. Off by default: unstretched is exact, and a varispeed is sometimes
  // what you want. Needs `fileBeats` -- there is no ratio without a length.
  fileStretch: false,
  fileRepeatOn: false,
  fileRepeatStart: numExpr(0),
  fileRepeatEnd: numExpr(4),
  audioSubdivisions: {
    inputText: "2:1",
    val: {
      notes: [{ time: 0, sounds: ["h"] }, { time: 0.5 }],
      start: 0,
      end: 1,
    },
    type: "parser2",
  } as Rhythm,
  visualMonitorOn: true,
  drums: [
    {
      path: "ride",
      on: true,
      volume: 1,
      offset: 0,
      shift: 0,
      gains: { inputText: "1", val: [1] },
      rhythm: {
        inputText: "2:1",
        val: { notes: [{ time: 0 }, { time: 0.5 }], start: 0, end: 1 },
        type: "parser2",
      },
    },
  ] as DrumVoice[],
  testObject: {
    notes: [{ time: 0, sounds: ["h"] }, { time: 0.5 }],
    start: 0,
    end: 1,
  },
};

// A rhythm as it round-trips through the UI: the text the user typed, the
// parsed form the drawing code reads, and which parser produced it.
export type Rhythm = {
  inputText: string;
  val: {
    notes: { time: number; sounds?: string[] }[];
    start: number;
    end: number;
  };
  type: "parser1" | "parser2";
};

// One grid overlay on the waveform. Grids are drawn bottom-of-the-list first,
// so where two grids land on the same beat the one nearer the top of the list
// is what you see.
export type VisualGrid = {
  color: string;
  // 0..1. Optional because presets saved before opacity existed don't carry it;
  // read it through gridAlpha rather than directly.
  alpha?: number;
  subdivisions: Rhythm;
  // Where the pattern starts, in beats -- a positive shift moves it later, the
  // same sign as a drum voice's. Optional for the same reason `alpha` is; read
  // it through gridShift. Expression-backed, unlike the drums', because grids
  // *are* walked by `resolveView` and so cannot go stale on a parameter change.
  shift?: NumberExpr;
};

export const gridAlpha = (grid: VisualGrid) =>
  typeof grid.alpha === "number" ? grid.alpha : 1;

export const gridShift = (grid: VisualGrid) =>
  grid.shift ? exprNumber(grid.shift) : 0;

// Handed out in order to newly added grids so each one starts visually distinct
// without the user having to pick a color.
export const GRID_COLORS = [
  "#0088ff",
  "#ff5533",
  "#33cc66",
  "#ffcc00",
  "#cc66ff",
  "#00ddcc",
  "#ff66aa",
  "#aaff33",
];

// Offered in order when adding a row color, so consecutive swatches start out
// easy to tell apart.
export const ROW_COLORS = [
  "#33cc66",
  "#0088ff",
  "#ff5533",
  "#ffcc00",
  "#cc66ff",
  "#00ddcc",
  "#ff66aa",
  "#aaff33",
  "#ffffff",
  "#888888",
];

// A named number, so "switch to 16ths" is one edit rather than five. A list
// rather than a map because the panel needs a stable order to draw the rows in.
// One pane of the waveform display. Everything here is per-view, so two panes
// can show the same audio against different grids and row lengths -- looking
// back and forth between 16ths and triplets is the whole point of having more
// than one.
export type ViewConfig = {
  // Where this pane sits in the `viewCols` x `viewRows` grid of cells, 0-based,
  // spanning `colSpan` x `rowSpan` of them. Explicit rather than derived from
  // the pane's index, which is what lets a cell be left empty and a pane be
  // twice as wide as its neighbour. No two panes may overlap and every pane
  // must fit -- enforced in one place, `fitViews` in `paneLayout.ts`, which
  // every path that can move a pane goes through.
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  // What this pane is called, drawn small in its own top corner. Frontend only
  // -- a label never reaches the audio thread -- and empty means draw nothing,
  // which is exactly what every pane did before this existed.
  name: string;
  // What the y axis of the pane means: amplitude, or frequency. Everything
  // else -- rows, margins, grids, the sweep -- is shared between the two.
  kind: ViewKind;
  // Which channels this pane draws, as *device* channel indices (inputs first,
  // then the synthetic drum and click buses). Per-pane, so one pane can watch
  // the drums while another watches what you played. The union of every pane's
  // list is what Rust is asked to pack into the sample stream, which is the
  // only part of this that reaches the audio thread.
  channels: number[];
  // Which *device* input channel the spectrogram shows. The analysis stream
  // carries the input channels in device order (up to Rust's cap), not the
  // `visibleChannels` subset, so this indexes it directly.
  spectrogramChannel: number;
  // Multiplies the normalised u8 magnitude, after the floor is subtracted.
  spectrogramGain: number;
  // 0..1 on the u8 scale: everything at or below it draws as background. The
  // dB range Rust sends is deliberately wide, so this is where the noise floor
  // actually gets chosen -- and changing it never pushes config across.
  spectrogramFloor: number;
  beatsPerRow: NumberListExpr;
  // How many strips the rows are wrapped into, side by side. 1 is one strip the
  // full width of the pane, which is every pane before this existed. A plain
  // number rather than an expression: it is a dropdown, with nowhere to type
  // one. Clamped to the row count on the way into the layout -- more columns
  // than rows is meaningless -- so this is only ever a request.
  rowColumns: number;
  marginLeft: NumberExpr;
  marginRight: NumberExpr;
  grids: VisualGrid[];
  visualGain: NumberExpr;
  barColorMode: boolean;
  refreshAtCycleEnd: boolean;
  // Colors a row's waveform can take, in the order `rowColorPattern` indexes
  // them. Empty means rows keep the channel's own color, which is what every
  // pane did before this existed.
  rowColors: string[];
  // Which row takes which color, 1-based and cycled by row index, in the same
  // "1, 2x3" syntax as beatsPerRow -- parameters and arithmetic included, since
  // `resolveView` walks it. Only consulted when `rowColors` has more than one
  // entry; empty means every row takes the first color. The bare-array branch
  // is a session written before it took expressions.
  rowColorPattern: NumberListExpr | number[];
  // The same, for the lower half of a split row. One palette, two patterns, so
  // the two channels in a split pane can be told apart while both still mark
  // the beat. Empty means the lower half reads `rowColorPattern` like the
  // upper one, which is how every pane behaved before this existed.
  rowColorPatternDown: NumberListExpr | number[];
  // Draw the spectral flux over the waveform, one bar per pixel column, in
  // each visible input channel's own colour. It arrives on the analysis stream
  // rather than the sample stream, so it is a second pass over the pane -- see
  // drawFlux in App.tsx.
  showFlux: boolean;
  // Mark each detected attack with a tick at the row's edge, in the channel's
  // colour. Discrete events rather than a curve, so unlike `showFlux` they
  // carry their own sub-hop beat and need no per-column accumulation.
  showOnsets: boolean;
  // Multiplies the flux before it is clamped to the row. A plain number, not an
  // expression: it's a slider, with nowhere to type one. Well below 1 by
  // default because a hard full-band attack measures around 2.3 -- the flux is
  // normalised so a threshold can be a single setting, not so it fills a row.
  fluxGain: number;
  // Draw the first visible channel above the centre line and the second below,
  // instead of overlaying them. With more than two, even slots go up and odd
  // slots go down.
  splitChannels: boolean;
};

// A factory rather than a constant: each view needs grid and row arrays of its
// own, or editing one pane's would edit every pane's.
// The color a row's waveform takes: the pane's row palette if it has one,
// otherwise null, meaning fall back to the channel's own color. The pattern is
// cycled by row index rather than stretched over the rows, so one shorter than
// the row list repeats down the pane -- with `0.25x16` rows and "1,2x3" that
// lands color 1 on exactly the rows that start a beat.
export const rowColorFor = (
  { rowColors, rowColorPattern, rowColorPatternDown }: ViewConfig,
  row: number,
  // Which half of a split row this is. The two halves are different channels,
  // so they can read the palette through different patterns -- "1,2x3" above
  // and "3,4x7" below picks two families out of one list.
  half: "both" | "up" | "down" = "both"
): string | null => {
  if (!rowColors.length) return null;
  // An empty down pattern means the halves agree, which is what every pane did
  // before the lower half could differ.
  const down = exprList(rowColorPatternDown ?? []);
  const pattern = half === "down" && down.length ? down : exprList(rowColorPattern ?? []);
  if (!pattern.length) return rowColors[0];
  const pick = Math.round(pattern[row % pattern.length]);
  // 1-based, and wrapped rather than clamped -- the same way drum `gains`
  // cycles, so a number past the end of the list comes back round to the start
  // instead of erroring or silently sticking on the last color.
  const i =
    (((pick - 1) % rowColors.length) + rowColors.length) % rowColors.length;
  return rowColors[i];
};

// What Rust is asked to send: every channel some pane wants, in device order.
// Derived rather than set, so the panes are the only place channel visibility
// is chosen -- `visibleChannels` is left as a transport detail.
export const unionChannels = (views: ViewConfig[]): number[] =>
  Array.from(new Set(views.flatMap((v) => v.channels))).sort((a, b) => a - b);

// A pane with no rows would divide by zero on the way to a row height.
// `parseNumberList` rejects an empty list, so this only catches a hand-edited
// or half-migrated session.
export const viewRowBeats = (view: ViewConfig): number[] => {
  const rows = exprList(view.beatsPerRow);
  return rows.length ? rows : [1];
};

export type ViewKind = "waveform" | "spectrogram";

export const VIEW_KINDS: ViewKind[] = ["waveform", "spectrogram"];

// Must match MAX_ANALYSIS_CHANNELS in src-tauri/src/analysis.rs. Duplicated
// rather than plumbed across because it only bounds the channel picker here.
export const MAX_ANALYSIS_CHANNELS = 4;

// The rate Rust adopted from the input device, fetched once at startup. Not a
// constant: a MacBook's built-in mic runs at 48 kHz, and a hard-coded 22050
// ceiling would put the top 2 kHz of the band out of reach on most Macs.
// Module level rather than passed down because the validators below are pure
// functions the input components call with no React context to read from.
let sampleRateHz = 44100;
export const getSampleRateHz = () => sampleRateHz;
export const analysisNyquist = () => sampleRateHz / 2;
export const setSampleRateHz = (hz: number) => {
  if (Number.isFinite(hz) && hz > 0) sampleRateHz = hz;
};

// How many bins Rust groups the spectrum into. Duplicated rather than plumbed
// across because the stream says its own `bins` -- this is only the fallback
// the draw code sizes a fresh accumulator from.
export const ANALYSIS_BINS = 64;

// Must match ANALYSIS_WINDOWS in src-tauri/src/analysis.rs. Duplicated rather
// than plumbed across because it only fills the dropdown here; Rust snaps
// anything else to the nearest of these anyway.
export const ANALYSIS_WINDOWS = [256, 512, 1024, 2048, 4096];

export const defaultViewConfig = (): ViewConfig => ({
  // The top-left cell, one cell wide. Every caller that cares where a pane
  // goes spreads a rectangle over this, so the default only has to be legal in
  // the smallest grid there is.
  col: 0,
  row: 0,
  colSpan: 1,
  rowSpan: 1,
  name: "",
  kind: "waveform",
  channels: [0],
  spectrogramChannel: 0,
  spectrogramGain: 1,
  spectrogramFloor: 0.15,
  beatsPerRow: { inputText: "2x2", val: [2, 2] },
  rowColumns: 1,
  marginLeft: { inputText: "0.11", val: 0.11 },
  marginRight: { inputText: "0.11", val: 0.11 },
  grids: [
    {
      color: GRID_COLORS[0],
      alpha: 1,
      subdivisions: {
        inputText: "2:1",
        val: { notes: [{ time: 0 }, { time: 0.5 }], start: 0, end: 1 },
        type: "parser2",
      },
    },
  ],
  visualGain: { inputText: "10", val: 10 },
  barColorMode: false,
  refreshAtCycleEnd: false,
  rowColors: [],
  rowColorPattern: { inputText: "", val: [] },
  rowColorPatternDown: { inputText: "", val: [] },
  showFlux: false,
  fluxGain: 0.3,
  showOnsets: false,
  splitChannels: false,
});

// Past this a row is narrower than it is tall at any useful row count, and the
// point of wrapping is to read the rows, not to fit them.
export const MAX_ROW_COLUMNS = 4;

// A pane grid past this is unreadable long before it's slow, and it keeps a
// stored 40x40 from building 1600 canvases on load.
export const MAX_VIEW_SIDE = 4;

// Views are copied rather than shared so two panes never end up pointing at one
// grid array, where editing either would edit both.
export const copyView = (view: ViewConfig): ViewConfig =>
  JSON.parse(JSON.stringify(view));

export const defaultJsConfig = {
  channelStyles: [] as ChannelStyle[],
  // Global rather than per-view: one set of names every pane's expressions can
  // reach, so `n` means the same thing wherever it's written.
  parameters: [] as Parameter[],
  // Drum grids: the editing surface for a drum part. Here rather than in the
  // rust config because nothing in a grid reaches the audio thread -- what it
  // compiles to is `drums`, an ordinary rhythm and an ordinary chances list.
  drumGrids: [] as DrumGrid[],
  views: [defaultViewConfig()] as ViewConfig[],
  // The pane arrangement: how many *cells* there are. Panes place themselves
  // in it explicitly (`col`/`row`/`colSpan`/`rowSpan`), so cells may be empty
  // and `views.length` is unrelated to `viewCols * viewRows` -- what used to
  // be an invariant is now only a ceiling. Shrinking the grid re-fits the
  // panes and drops any that no longer have a cell; see `paneLayout.ts`.
  // Per-channel display trim, multiplied into the pane's own `visualGain`.
  // Display only, so unlike the pans it never reaches the audio thread, and it
  // applies to every channel including the synthetic buses. Sparse: a channel
  // with no entry draws at 1.
  channelGains: [] as number[],
  viewCols: 1,
  viewRows: 1,
  // Chained rather than simultaneous panes: instead of every pane drawing the
  // same beats against its own ruling, the panes divide one long timeline
  // between them, so the signal runs through pane 1's rows, then pane 2's.
  viewsSequential: false,
  // The file to play along with, kept so a session comes back with it loaded.
  // Rust holds the decoded samples, not the path, so this is the only record of
  // it -- the frontend pushes it back through `set_mp3_buffer` on mount.
  filePath: "",

  // Layout chrome. Global rather than per-pane: the gutter is *between* panes
  // and belongs to no one of them, and a background that changed pane by pane
  // would read as a difference in the signal rather than in the frame. Row
  // colors stay per-pane -- those describe what is drawn, these describe what
  // it is drawn on.
  //
  // What a pane is erased to. The sweep never clears the canvas, it repaints
  // one column at a time, so this is the color of every part of a pane nothing
  // has been drawn over.
  waveformBackground: "#222222",
  // The gutter between panes, in CSS pixels. Zero butts them together; the
  // canvas backing store is unaffected, so this only moves where the panes sit,
  // never what is drawn in them.
  paneGap: 2,
  // What shows through that gutter -- and, since a cell may now hold no pane at
  // all, what an empty cell is. Invisible only when a single pane covers every
  // cell and the gap is 0, because then there is nothing behind the panes to
  // see.
  paneGapColor: "#333333",
  // Grid line thickness, in **CSS** pixels, so a line is the same weight on a
  // Retina display and an external monitor -- the draw code multiplies by the
  // pane's device pixel ratio. 0.5 is therefore one device pixel on a 2x
  // display, the thinnest line that screen can draw; 1 is what the hard-coded
  // `lineWidth = 2` came to there, so the default changes nothing.
  gridWidth: 1,
  // A diagnostic overlay: how long a frame's drawing takes, and whether the
  // loop is keeping up. Off by default, and it writes to the DOM directly
  // rather than through React, so having it on perturbs nothing it measures.
  showFrameTime: false,
};

export type RustConfig = typeof defaultRustConfig;

export type RustConfigKey = keyof RustConfig;

export const isRustConfigKey = (k: string): k is RustConfigKey =>
  k in defaultRustConfig;

export type JsConfig = typeof defaultJsConfig;

export type JsConfigKey = keyof JsConfig;

export const isJsConfigKey = (k: string): k is JsConfigKey =>
  k in defaultJsConfig;

export type ViewConfigKey = keyof ViewConfig;

// Checked against a throwaway instance because defaultViewConfig is a factory.
const VIEW_CONFIG_TEMPLATE = defaultViewConfig();

export const isViewConfigKey = (k: string): k is ViewConfigKey =>
  k in VIEW_CONFIG_TEMPLATE;

// View keys are in here so `Input` can be typed against them, but they live in
// neither default object -- the plain get/set can't reach them, only the
// view-scoped pair App hands to the per-view panel.
export type Config = RustConfig & JsConfig & ViewConfig;

export type ConfigKey = keyof Config;

// Later duplicates would silently win, so the first binding of a name is the
// one that counts. The panel refuses to create a duplicate; this only decides
// what a hand-edited session does.
export const parameterText = (p: Parameter): string =>
  p.inputText ??
  (Array.isArray(p.value) ? formatNumberList(p.value) : String(p.value));

// Scalar first: `parseNumberList("4")` is `[4]`, a one-element *list*, so
// trying it first would quietly turn every literal into one.
const evaluateParameter = (
  p: Parameter,
  values: Params,
  rng?: Rng
): number | number[] => {
  const text = parameterText(p);
  try {
    return evaluate(text, values, rng);
  } catch (scalarError) {
    try {
      return parseNumberList(text, values, rng);
    } catch (listError) {
      // The scalar error is almost always the informative one -- "unknown
      // parameter n" rather than whatever the list parser made of it.
      throw text.includes(",") || text.includes("[") ? listError : scalarError;
    }
  }
};

export type ParameterResolution = {
  values: Params;
  /** name -> why it didn't resolve. */
  failed: Record<string, string>;
};

/**
 * Parameters may reference other parameters, in any order, so long as the
 * references form a DAG.
 *
 * The DAG is enforced without building one: each pass resolves every parameter
 * whose references are already resolved, and when a pass resolves *nothing*,
 * whatever is left is a cycle, or depends on one, or names something that
 * doesn't exist. That is the same answer a topological sort gives, and it needs
 * no graph, no visited set, and no recursion.
 *
 * A parameter that fails contributes *nothing* rather than its cached value.
 * Falling back to the cache would let a cycle appear to work off stale numbers,
 * which is the one outcome worse than an error. Fields referring to it go red
 * and keep their own last good values, exactly as when a parameter is deleted.
 */
export const isRandomParameter = (p: Parameter): boolean =>
  isRandomText(parameterText(p));

export const resolveParameters = (
  parameters: Parameter[],
  roll?: (name: string) => boolean
): ParameterResolution => {
  const values: Params = {};
  const failed: Record<string, string> = {};
  // First definition of a name wins, as it always has.
  const seen = new Set<string>();
  let remaining = parameters.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
  const errors: Record<string, string> = {};

  while (remaining.length) {
    const next: Parameter[] = [];
    let progressed = false;
    for (const p of remaining) {
      // A random parameter's stored value *is* its value. The whole config is
      // re-resolved on every keystroke, so evaluating `choose(1,2,3)` here
      // would re-roll it constantly; a roll happens only when something asks
      // for one, and until then this is a literal like any other.
      if (isRandomParameter(p) && !roll?.(p.name) && p.value !== undefined) {
        values[p.name] = p.value;
        progressed = true;
        continue;
      }
      try {
        values[p.name] = evaluateParameter(p, values, Math.random);
        progressed = true;
      } catch (e) {
        errors[p.name] = (e as Error).message;
        next.push(p);
      }
    }
    remaining = next;
    if (!progressed) break;
  }

  const stuck = new Set(remaining.map((p) => p.name));
  for (const p of remaining) {
    const circular = referencedNames(parameterText(p)).some((n) => stuck.has(n));
    failed[p.name] = circular
      ? "circular reference"
      : errors[p.name] ?? "unresolved";
  }
  return { values, failed };
};

export const parameterValues = (parameters: Parameter[]): Params =>
  resolveParameters(parameters).values;

/**
 * Re-rolls the random parameters `pick` names, writing each new draw back as
 * that parameter's stored value.
 *
 * Nothing else has to be told. A parameter that references a rolled one, and
 * every expression-backed field in either config, re-derives from the stored
 * values on the next resolve -- which is exactly what happens when any
 * parameter is edited by hand.
 */
export const rollParameters = (
  parameters: Parameter[],
  pick: (name: string) => boolean = () => true
): Parameter[] => {
  const { values } = resolveParameters(parameters, pick);
  return parameters.map((p) =>
    isRandomParameter(p) && pick(p.name) && p.name in values
      ? { ...p, value: values[p.name] }
      : p
  );
};

// Failure keeps the last good `val` and leaves the text alone. Deleting a
// parameter shouldn't wipe every field that referred to it -- the field goes
// red and waits to be fixed, and meanwhile the pane still draws.
const resolveNumber = (
  field: NumberExpr,
  params: Params,
  validate?: (n: number) => boolean
): NumberExpr => {
  if (!field || typeof field.inputText !== "string") return field;
  try {
    const val = evaluate(field.inputText, params);
    // A validator failing is treated exactly like a parse failure: keep the last
    // good value. It matters most for bpm, where `n - n` would otherwise push a
    // 0 to Rust and `get_loop_spacing` would divide by it.
    if (validate && !validate(val)) return field;
    return { inputText: field.inputText, val };
  } catch (e) {
    return field;
  }
};

const resolveList = (
  field: NumberListExpr,
  params: Params
): NumberListExpr => {
  if (!field || typeof field.inputText !== "string") return field;
  try {
    return {
      inputText: field.inputText,
      val: parseNumberList(field.inputText, params),
    };
  } catch (e) {
    return field;
  }
};

// A rhythm the audio thread will actually take: a cycle with a length, and
// every note at a real time. A NaN time is written to the session as JSON
// `null`, and serde refuses `null` for an f64 -- so one saved into a session
// would reject *every* config push for the life of the app, and unfixably,
// since the session is restored before anything can be retyped.
//
// Arrays are parser1's shape and are left alone: nothing creates one any more,
// and they were never a shape this check describes.
export const usableRhythmVal = (val: unknown): boolean => {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const { notes, end } = val as { notes?: unknown; end?: unknown };
  if (!Array.isArray(notes)) return false;
  if (typeof end !== "number" || !Number.isFinite(end) || end <= 0) return false;
  return notes.every(
    (n) =>
      typeof n === "object" &&
      n !== null &&
      typeof (n as { time?: unknown }).time === "number" &&
      Number.isFinite((n as { time: number }).time)
  );
};

const resolveRhythm = (rhythm: Rhythm, params: Params): Rhythm => {
  try {
    const text = resolveRhythmText(rhythm.inputText, params);
    // Nothing in it referred to a parameter, so the stored val can't have
    // moved -- and text the parsers no longer accept is never re-parsed.
    if (text === rhythm.inputText) return rhythm;
    const parser = rhythm.type === "parser1" ? parser1 : parser2;
    const val = parser.parse(text);
    // A parameter can make a rhythm degenerate without the field being touched
    // -- `n:1` with n set to 0 -- and that push has to be refused here, since
    // there's no input component watching to turn red.
    if (rhythm.type !== "parser1" && !usableRhythmVal(val)) return rhythm;
    return { ...rhythm, val };
  } catch (e) {
    return rhythm;
  }
};

// A list field that may still be a bare array, from a session written before it
// took expressions. Wrapped rather than renamed, so saved palettes survive --
// the same trade `normalizeView` makes for `beatsPerRow`.
const asListExpr = (field: NumberListExpr | number[]): NumberListExpr =>
  Array.isArray(field)
    ? { inputText: formatNumberList(field), val: field }
    : field;

const resolveView = (view: ViewConfig, params: Params): ViewConfig => ({
  ...view,
  beatsPerRow: resolveList(view.beatsPerRow, params),
  // In the walk, which is what lets them take expressions at all: the draw loop
  // reads `val` directly and nothing re-parses the text on its own.
  rowColorPattern: resolveList(asListExpr(view.rowColorPattern), params),
  rowColorPatternDown: resolveList(
    asListExpr(view.rowColorPatternDown),
    params
  ),
  marginLeft: resolveNumber(view.marginLeft, params),
  marginRight: resolveNumber(view.marginRight, params),
  visualGain: resolveNumber(view.visualGain, params),
  grids: view.grids.map((g) => ({
    ...g,
    subdivisions: resolveRhythm(g.subdivisions, params),
    // Left absent rather than defaulted, so a grid saved before this keeps its
    // shape and `gridShift` answers 0 for it.
    shift: g.shift ? resolveNumber(g.shift, params) : g.shift,
  })),
});

// Re-evaluates every expression-backed field against the config's own
// parameters. Called from the parameter setter, inside the same update, rather
// than from an effect: an effect that writes config is a render loop waiting to
// happen, and the draw loop reads `val` directly, so it would also draw one
// frame from stale numbers.
// The rust-side expression fields, with the guards that keep a nonsense value
// from crossing. Nothing in the frontend reads these -- they exist only to be
// pushed to the audio thread -- so `unwrapValues` stripping them to `val` is the
// whole of the Rust-side story.
// A band edge past Nyquist describes no bin at all; Rust falls back to the full
// range rather than reporting nothing, which would read as the flux being
// broken. Rejecting here is the honest place to say so.
const inBand = (n: number) => Number.isFinite(n) && n > 0 && n < analysisNyquist();

const RUST_EXPR_FIELDS: {
  key: RustExprKey;
  validate?: (n: number) => boolean;
}[] = [
  { key: "bpm", validate: (n) => n > 0 && n < 100000 },
  { key: "beatsToLoop", validate: (n) => n > 0 },
  { key: "loopEchoes", validate: (n) => n >= 1 && n <= MAX_LOOP_ECHOES },
  { key: "loopEchoGain", validate: (n) => n >= 0 && n <= 1 },
  { key: "onsetThreshold", validate: (n) => Number.isFinite(n) && n >= 0 },
  { key: "onsetMinGap", validate: (n) => Number.isFinite(n) && n >= 0 && n < 10000 },
  { key: "onsetOffset", validate: (n) => Number.isFinite(n) && Math.abs(n) < 10000 },
  { key: "clickVolume", validate: (n) => n >= 0 },
  { key: "clickShift", validate: (n) => Number.isFinite(n) && Math.abs(n) < 100000 },
  { key: "fileVolume", validate: (n) => n >= 0 },
  // 0 is the "not declared" case, so this is >= rather than > 0.
  { key: "fileBeats", validate: (n) => Number.isFinite(n) && n >= 0 && n < 100000 },
  { key: "fileOffsetMs", validate: (n) => Number.isFinite(n) && Math.abs(n) < 100000 },
  { key: "fileShift", validate: (n) => Number.isFinite(n) && Math.abs(n) < 100000 },
  // Either end may sit past the file's length -- the segment wraps -- so these
  // are bounded rather than clamped to `fileBeats`. A backwards or zero-length
  // segment falls back to the whole file in the callback rather than being
  // refused here, since it's a state you pass through while typing the other end.
  { key: "fileRepeatStart", validate: (n) => Number.isFinite(n) && Math.abs(n) < 100000 },
  { key: "fileRepeatEnd", validate: (n) => Number.isFinite(n) && Math.abs(n) < 100000 },
  { key: "audioInGain", validate: (n) => n >= 0 },
  // Nothing above Nyquist describes a frequency, and both degenerate answers
  // are safe in the callback anyway -- this is the honest place to say so.
  { key: "highPassHz", validate: inBand },
  { key: "bufferCompensation", validate: (n) => n >= 0 },
  { key: "analysisBandLow", validate: inBand },
  { key: "analysisBandHigh", validate: inBand },
];

export const resolveRustConfig = (
  rust: RustConfig,
  params: Params
): RustConfig => {
  const out = { ...rust } as Record<string, unknown>;
  for (const { key, validate } of RUST_EXPR_FIELDS) {
    out[key] = resolveNumber(rust[key], params, validate);
  }
  out.audioSubdivisions = resolveRhythm(rust.audioSubdivisions, params);
  // In the walk for the same reason drum gains are: nothing on this side reads
  // a section's length, so without it a parameter change would leave the old
  // number gating the audio thread indefinitely.
  out.sections = rust.sections.map((s) => ({
    ...s,
    beats: resolveNumber(
      Array.isArray(s.beats) || typeof s.beats === "number"
        ? { inputText: String(s.beats), val: Number(s.beats) }
        : s.beats,
      params,
      (n) => Number.isFinite(n) && n > 0 && n < 100000
    ),
  }));
  out.sectionOrder = resolveList(
    asListExpr(rust.sectionOrder ?? { inputText: "", val: [] }),
    params
  );
  // In the walk for the same reason: nothing on this side reads the record
  // cycle, so without it a parameter change would leave the old lengths gating
  // the audio thread indefinitely.
  out.loopRecordCycle = resolveList(
    asListExpr(rust.loopRecordCycle ?? defaultRustConfig.loopRecordCycle),
    params
  );
  out.drums = rust.drums.map((d) => ({
    ...d,
    rhythm: resolveRhythm(d.rhythm, params),
    // Being in this walk is the prerequisite for taking an expression at all:
    // nothing in the frontend reads a drum voice's gains, so without it a
    // parameter change would leave the old numbers sounding indefinitely.
    // `offset` and `shift` are still literals precisely because they aren't
    // here -- add them before making them expression-backed, not after.
    gains: d.gains ? resolveList(normalizeGains(d.gains), params) : d.gains,
    chances: d.chances
      ? resolveList(normalizeChances(d.chances), params)
      : d.chances,
  }));
  return out as RustConfig;
};

export const resolveJsConfig = (js: JsConfig): JsConfig => {
  const { values } = resolveParameters(js.parameters);
  // Parameters carry their own cache, so a parameter that depends on one that
  // just changed has to be written back here too -- otherwise `b = a*2` keeps
  // showing the old product everywhere `value` is read directly.
  const parameters = js.parameters.map((p) =>
    p.name in values ? { ...p, value: values[p.name] } : p
  );
  return {
    ...js,
    parameters,
    // In the walk, which is the prerequisite for the pulse taking an expression
    // at all: the compile reads `val` and nothing re-parses the text on its
    // own, so without this a parameter change would leave every gridded voice
    // sounding the old division.
    drumGrids: js.drumGrids.map((g) => ({
      ...g,
      pulse: resolveList(asListExpr(g.pulse), values),
    })),
    views: js.views.map((v) => resolveView(v, values)),
  };
};

/**
 * The two halves, resolved together.
 *
 * A grid lives in the js config and what it compiles to lands in the rust one,
 * so re-resolving either alone leaves a rhythm nobody on this side re-reads
 * stale -- the trap the expression fields' `val` rules exist for. Every path
 * that resolves config goes through here: startup, `setParameters`,
 * `loadPreset`, the restored session.
 */
export const resolveConfigs = (
  rust: RustConfig,
  js: JsConfig
): { rust: RustConfig; js: JsConfig } => {
  const nextJs = resolveJsConfig(js);
  const params = parameterValues(nextJs.parameters);
  const nextRust = resolveRustConfig(rust, params);
  return {
    js: nextJs,
    rust: { ...nextRust, drums: applyDrumGrids(nextRust.drums, nextJs.drumGrids) },
  };
};
