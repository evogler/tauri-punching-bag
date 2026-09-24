// The palette, for inline styles.
//
// `src/index.css` holds the real values as custom properties on `:root`; this
// is a typed accessor that hands back `var(--x)` strings, so there is exactly
// one place a colour is written down. React puts a `var()` through to the
// style attribute unchanged, so an inline style is as good a consumer as a
// stylesheet rule.
//
// **Canvas drawing cannot read these**, because `ctx.fillStyle = "var(--x)"`
// is not a colour. Nothing in the draw path needs to: every colour it uses is
// config -- `waveformBackground`, `rowColorFor`, a channel's style, a grid's
// colour -- or derived from one, like the pane name's black-or-white ink.
//
// Named by role. Where two near-identical shades were doing one job they were
// collapsed onto it rather than preserved as two tokens: an error message was
// `#fbb` in five places and `#f88` in three, a device warning `#e08`, and a
// passing measurement `#6c6` or `#8c8` depending on which file you were in.
const v = (name: string) => `var(--${name})`;

export const ui = {
  surface: {
    app: v("surface-app"),
    well: v("surface-well"),
    sunken: v("surface-sunken"),
    field: v("surface-field"),
    panel: v("surface-panel"),
    inset: v("surface-inset"),
    raised: v("surface-raised"),
    selected: v("surface-selected"),
  },
  line: {
    hairline: v("line-hairline"),
    field: v("line-field"),
    divider: v("line-divider"),
  },
  text: {
    bright: v("text-bright"),
    primary: v("text-primary"),
    body: v("text-body"),
    muted: v("text-muted"),
    dim: v("text-dim"),
    faint: v("text-faint"),
    caption: v("text-caption"),
    onAccent: v("text-on-accent"),
  },
  accent: v("accent"),
  accentEdge: v("accent-edge"),
  ok: v("ok"),
  warn: v("warn"),
  bad: v("bad"),
  notice: v("notice"),
  info: v("info"),
  error: v("error"),
  danger: v("danger"),
  dangerFill: v("danger-fill"),
  hintFill: v("hint-fill"),
  hintText: v("hint-text"),
  overlayInk: v("overlay-ink"),
  dropLine: v("drop-line"),

  /// Monospace, for a number or an expression. A face rather than a colour,
  /// but it belongs to the same system and has the same one-place rule.
  mono: v("font-mono"),
} as const;
