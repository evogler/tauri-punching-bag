# tauri-punching-bag

A practice tool for drummers/musicians: a metronome with programmable rhythms, a
looper, and a real-time waveform display you play *against*. Tauri v1 app —
React/TypeScript frontend, Rust + CoreAudio backend. macOS only (uses
`coreaudio-rs` directly, not `cpal`).

## Commands

```
yarn dev            # tauri dev
yarn tauri build    # ALWAYS run this after a change (see below)
yarn start          # browser-only, fakes samples; no Rust backend
npx tsc --noEmit    # typecheck
```

**Run `yarn tauri build` after every change.** The owner asked for this
explicitly. `tsc` and `react-scripts build` only cover the frontend; the Tauri
build also compiles Rust and packages the app, and it's fast (~30s) because the
Rust deps are already built. Three warnings are pre-existing and expected
(`unused import: std::time::Instant`, `unused imports: AudioUnit and Error`, and
`method hop_frames is never used`).

If the DMG step fails with `error running bundle_dmg.sh`, **do not just re-run
it** — see *The disk image step*. That message covers every possible cause, the
two real ones are a stale mounted volume and a missing App Management grant, and
neither is fixed by trying again.

## Architecture

Two halves that talk through exactly two channels:

- **Config push (JS → Rust).** Any setting change calls `set_config` with the
  whole config object. Rust holds it behind a mutex; the audio callback reads it
  every callback.
- **Sample poll (Rust → JS).** The audio callback appends to a shared buffer;
  the frontend polls `get_samples` at 100 Hz and draws.

`beat: f64` in the audio callback is the master clock — it advances by
`beats_per_sample` per frame and never wraps. Everything (click, drums, display
position, looper) derives from it.

### Layout of the Rust side

| File | Role |
|---|---|
| `main.rs` | Setup + the render callback. Nearly all real-time logic lives in one closure. |
| `io_channels.rs` | Device discovery, stream formats, input callback, per-channel queues. |
| `structs.rs` | Config, shared state, `DrumVoice`, `VisualSamples`. |
| `commands.rs` | Tauri commands (`set_config`, `get_samples`, `load_drum_sample`, …). |
| `constants.rs` | `SAMPLE_RATE`, `MAX_INPUT_BACKLOG`, `default_config()`. |
| `util.rs` | `beat_bisect` (which subdivision a beat falls in), `mod_add`. |
| `analysis.rs` | The short-time FFT behind the spectrogram and the spectral flux (see below). |
| `filter.rs` | The high pass over the input. Pure logic, no Core Audio. |
| `calibration.rs` | The round-trip latency measurement -- probe, matched filter, gates. |
| `stretch.rs` | WSOLA time stretching for the file player, and the off-thread render that applies it. |
| `prefs.rs` | `audio-prefs.json`: device choice and per-pair latency. Not the config. |

### Layout of the frontend

| File | Role |
|---|---|
| `App.tsx` | State, config plumbing, the whole canvas draw path. Large. |
| `panel/` | The settings panel: `Panel.tsx` composes `PanelHeader` and one file per tab; `chrome.tsx` has `Section` / `Divider` / `TabBar` / `TabPanel`; `types.ts` is the one props bundle every tab gets from `App`. |
| `config.ts` | `defaultRustConfig` / `defaultJsConfig` — the split below matters. |
| `layout.ts` | `getCanvasPositions` — pure geometry, where a beat lands on screen. |
| `paneLayout.ts` | Where each pane sits in the grid, and every operation that moves one. `fitViews` is the one place the no-overlap invariant is enforced. Pure. |
| `PaneMap.tsx` | The arrangement as a picture: the pane selector, the `+` in an empty cell, and the grow/shrink/swap buttons. |
| `Input.tsx` | Generic config inputs, dispatched on value type. |
| `expression.ts` | The parameter expression language, and `parseNumberList` / `formatNumberList` built on it. Pure. |
| `ParameterList.tsx` | The named-number UI. |
| `GridList.tsx` / `ChannelList.tsx` / `DrumList.tsx` | The three list UIs. |
| `RowColorList.tsx` | The per-view row color swatches. |
| `SpectrogramControls.tsx` | The per-view spectrogram channel/gain/floor controls. |
| `Slider.tsx` | The labelled range input those and `flux gain` share. |
| `presets.ts` | Named presets *and* the auto-restored session. |
| `parser1.js` / `parser2.js` | Generated PEG parsers for rhythm syntax (see Rhythm syntax). Don't hand-edit -- `parser2.js` is built from `parser2.peg` by `yarn build:parser`. `parser1.js` has no source and is legacy. |

## The config system — sharp edges

Config is split three ways by *where it's needed*: `defaultRustConfig` (audio),
`defaultJsConfig` (display, global), and `defaultViewConfig` (display, per-pane).
`get(key)` / `set(key, value)` route by which of the first two the key lives in.
Adding a key to the wrong one silently does nothing.

Rules that will bite you:

- **`snakeCaseKeys` is top-level only.** A nested Rust struct field must be a
  single lowercase word, or serde won't match it. This is why `DrumVoice` has
  `offset` (documented as ms) rather than `offset_ms`.
- **`unwrapValues` is recursive.** Rhythms are stored as
  `{inputText, val, type}` so fields keep what was typed; Rust only wants `val`.
  Drum voices nest a rhythm inside an array, hence the recursion.
- **The `react-hooks` eslint plugin is not loaded.** An
  `// eslint-disable-next-line react-hooks/exhaustive-deps` comment is itself a
  *build error* ("Definition for rule … was not found"). Don't add one.
- **View keys are unreachable from the plain `get`/`set`.** They live in
  `views[i]`, in neither default object, so `isRustConfigKey` and `isJsConfigKey`
  both miss and `set` does nothing. `Config` includes `ViewConfig` only so
  `Input` can be typed against those keys; the panel reaches them through the
  view-scoped pair `viewSetGet(i)` returns, which falls through to the global
  `get`/`set` for everything else.
- **Transient keys.** `presets.ts` excludes `paused` (transport state) from both
  presets and the saved session. `canvasWidth`/`canvasHeight` are gone from the
  config entirely -- each pane is measured from its own box now.
- **Machine keys.** `LOCAL_RUST_KEYS` is `bufferCompensation`, excluded from
  presets and the session *and* carried across a preset load. A preset travels
  between machines and between input/output pairs, where a latency measured
  somewhere else is noise; `audio-prefs.json` holds it per device pair, which is
  the right home. Both halves are load-bearing, and the failure was destructive
  either way: without the exclusion a preset overwrote the measured value, and
  the write-back effect then saved *that* into `audio-prefs.json` for the
  current pair -- a calibration you would have to measure again. Without the
  carry-across, merging over the defaults resets it to 4330 and the same effect
  saves that instead. `KEPT_RUST_KEYS` is the two lists together and is what
  `loadPreset` spreads *last*, so they win even over an older preset that still
  carries them.
- **Never reuse a config key name with different semantics or a different
  default.** Restore merges the saved value *over* the default, so a session
  written by an older build silently wins. This bit once: `loopFeedback` was a
  recursive feedback amount defaulting to 0, then became a per-echo gain
  defaulting to 1 — sessions written by the first build restored the 0 and
  silenced every echo after the first, which looked like the echo count being
  ignored. Renaming it to `loopEchoGain` was the fix, because unrecognized keys
  *are* dropped. Rename rather than redefine.
- **Both session restore and preset load merge over the *defaults*.** Preset
  load used to merge over the config in use, which made a preset mean "these
  settings, plus whatever you happen to have": a preset saved before a feature
  existed could not turn that feature off, and loading A then B gave a hybrid
  neither one describes. A practice cycle outliving a preset that had none was
  this, and so was a file going on playing. The cost is that a key added since a
  preset was saved comes back at its default -- the honest answer, and the one
  restore already gave.
- **Session restore** merges over defaults, so new keys keep their default and
  removed keys are dropped. **The frontend pushes one `set_config` on mount
  whether or not a session was restored**, and Rust is *silent* until it
  arrives.
  - Rust boots from its own `default_config()`, which is a second definition of
    the defaults and is nobody's saved settings. The window takes a moment to
    come up, and for that moment the callback used to sound it -- a beat of the
    wrong tempo and the wrong click on every launch, before the saved state
    landed. `ConfigReady` is an atomic the callback reads and `set_config`
    sets, and "not yet" is treated **exactly as a pause**: output silenced, the
    input still drained (the queue is shared and would otherwise grow and then
    replay), the levels still metered so the setup wizard's microphone check
    works, and the beat held at zero so the first cycle starts on one.
  - **The push had been conditional on there being a session**, which is why
    the gate needs both halves: a fresh install would otherwise never become
    audible. Pushing unconditionally also keeps the frontend the one source of
    truth, rather than leaving a launch running on whatever `default_config()`
    happens to say.
  - If the webview never loads, the app stays silent. That is the right way
    round -- the alternative is playing settings nobody chose.

## The panel, the shortcuts and the menu

- **The panel is ten sections, listed down a rail on its left-hand edge** --
  examples, presets, parameters, play, file, loop, display, layout, analysis,
  setup. **The transport, the tempo and the looper switch are outside it
  altogether, in the window's top bar**: those are reached for mid-phrase, and
  tempo belongs to no one section. `docs/approachability.md` has the exact
  arrangement and why each control sits where it does.
  - **Examples, presets and parameters were pinned above the tabs** and became
    sections on the owner's call. Three boxes standing open over every tab --
    two of them collapsed to a heading and so saying nothing at all -- was
    clutter in the one part of the panel that is always on screen. What it
    costs is real and was weighed: parameters were pinned precisely so `n`
    could be edited while looking at a field that reads `bar/n x n`, and from
    its own section you cannot see both. The list shows what each name resolves
    to, which is the consolation.
  - **They are unlabelled `Section`s**, since the rail already says where you
    are. Every other section's captions name a group *inside* it, which is a
    different job.
  - **A column, not the row of tabs it replaced.** A row divides one panel
    width between however many sections there are: at seven each tab was
    already 85px and the next few would have truncated their own labels, which
    is a layout that gets worse exactly as the app grows. A column costs a
    fixed strip of width once and then grows for nothing.
  - **The try-this line is held above both the picker and the header**
  (`useExampleHint` in `ExampleBar.tsx`). The advice is about what to go and
  *do*, so you load an example and then leave for Play, where the line has to
  still be there -- it cannot live in the section that raised it. The config
  error banner is the same shape of thing for the same reason, and both sit at
  the top of the scrolling column rather than pinned.
- **The rail is a sibling of the scrolling settings, not inside them**, which
    is the whole point: the list stays where you left it however far down the
    open section you are. Same argument as the help area, which is why they are
    the two things in the panel that do not scroll.
  - **On the panel's left, against the window edge**, which is also where it
    puts the settings' scrollbar: against the canvas rather than between the
    settings and the rail, where the open section's flat edge would have had to
    reach across it.
  - **`TAB_GROUPS` is the source of truth and `PanelTab` is derived from it.**
    A separate flat list of section names would let a new section be added
    without being put in a group, and an ungrouped section is one the rail
    never draws -- a tab you cannot reach, with nothing saying so. Deriving the
    type makes that unrepresentable rather than something to remember.
  - **The groups are headed** (sound, picture, machine), because a column of
    ten unbroken entries reads as a list to search rather than a place to go.
    Analysis is under the picture rather than on its own: the high pass is
    explicitly for the picture, and the spectrum and the onsets are drawn.
  - **Each rail button carries its own help entry**, so pointing down the list
    is a tour of what the app can do -- the one place where hovering the
    *navigation* is worth explaining rather than only the controls.
- **Every colour in the app is a custom property on `:root` in
  `src/index.css`, and nowhere else.** `src/theme.ts` exports `ui`, a typed
  accessor handing back `var(--x)` strings rather than a second copy of the
  values -- React passes a `var()` through to the style attribute unchanged,
  so an inline style is as good a consumer as a stylesheet rule. Before this
  the panel held ~130 hex literals across 30 files (`#aaa` forty times), so a
  palette change was a hundred and thirty hand edits and the next one was
  another hundred and thirty.
  - **Named by role, never by value** -- `--surface-panel`, not `--grey-444`
    -- or the rename is only a second spelling of the hex it replaced.
  - **The data colours are deliberately outside it.** `channelStyles`,
    `rowColors`, a grid's colour, `waveformBackground`, `paneGapColor` and
    `RowPerNote`'s target and antipode are *config*: chosen per pane, carried
    in presets, edited afterwards. A token would make somebody's palette a
    build-time constant. Canvas drawing could not read a `var()` anyway
    (`ctx.fillStyle = "var(--x)"` is not a colour), and needs to read none of
    these -- every colour in the draw path is config or derived from one.
  - **Near-identical shades doing one job were collapsed onto it** rather than
    preserved as two tokens: an error message was `#fbb`, `#f88` or `#e08`
    depending on the file, and a passing measurement `#6c6` or `#8c8`. Tokens
    named for their spelling would defeat the point.
  - **The two config colours were migrated, not just redefaulted.** Restore
    merges saved values over the defaults, so exactly `#222222` and `#333333`
    -- the old defaults, indistinguishable from an untouched install -- move
    to the new ones in `migratedChromeColors`. Without it every existing
    install keeps a mid-grey canvas beside a near-black panel. The
    `onsetThreshold` argument, and the same cost: a deliberate `#222222` moves
    too.
  - **Faces are tokens as well** (`--font-sans`, `--font-mono`), so bundling
    Instrument Sans and JetBrains Mono later is one line rather than a sweep.
    They are **not** webfont-linked: the mockups pull them from
    `fonts.googleapis.com` because an artboard is a web page, and a bundle
    that cannot reach Google would fall back silently with nothing in any log.
    macOS gives SF Pro and SF Mono meanwhile, and the important half is that a
    number is monospaced and tabular rather than which monospace it is.
  - **Every text field is monospace and tabular**, because every one of them
    holds a number, an expression or a rhythm. `select` is excluded -- a
    device name is prose. The size is deliberately unchanged: shrinking it to
    win back the width mono costs would undo the one-size rule below.
  - **Three colours failed contrast and were fixed in the token file** rather
    than discovered later in thirty places. The mockups' `#5E686F` rail digits
    are 3.16:1 and `#6B757C` tick labels 3.93:1, where 4.5:1 is the bar;
    `#7D878E` is 4.27:1 on a raised surface, which is why the dim text token
    is `#868F96` (4.76) instead. Disabled text is exempt and left below the
    bar on purpose.
- **The panel's controls are styled in `src/index.css`, not inline**, because
  what was wrong with them was systematic rather than per-component. Measured
  against Audacity's preferences window, which is the same kind of surface done
  conventionally, and the gap sorted into one sentence: *that page emphasises
  the values and lets the structure recede, and this one did the opposite.*
  Four changes, in the order of how much they mattered:
  - **A field has to look like a field.** `input` was `border: 0` over the same
    `#444` the sections are filled with, so every number sat in the panel as
    plain text with nothing to say it could be typed in. They are recessed now
    -- darker than what they sit on, with a hairline -- and the selector is
    `input:not([type])` because our text fields carry no `type` at all, while
    checkboxes, colour wells and range sliders must keep the native look they
    are recognised by.
  - **One type size.** Form controls default to 13.3px while body text was
    16px, so every *value* was smaller and quieter than the label beside it --
    exactly the wrong way round, since the value is the part you came to
    change. `body` is 14px and every control inherits it. 14 rather than 16
    because the panel is a fixed 600px and the density has to come from
    somewhere; every `0.8em` note in the tree followed it down.
  - **Chrome stopped shouting.** Unstyled `button` and `select` come out of the
    system *white*, so Pause, Restart, Load, the help toggle and the one
    dropdown were the brightest things on the screen while the settings were
    the dimmest. A native `select` needs `appearance: none` to give that up,
    which means drawing the chevron -- an inline SVG, so it sits where it is
    put at any size. Checkboxes went the same way: a white square says nothing
    until it is ticked, and the drum list stacks half a dozen of them.
  - **Inline styles still win**, which is how the paused transport stays red,
    the section rail keeps its own shape, and `invalidBorder` still turns a
    field red. They read their colours from `ui` now rather than writing
    hexes, so winning costs nothing in consistency.
- **A section's name is a caption, not a title.** An unstyled `h4` is bold and
  the same size as the labels under it, so the name of a group competed with
  the settings inside it. Smaller and quieter than its own contents is the
  right way round, and it is the same uppercase treatment the rail's group
  names get. `Divider`'s label then had to stop being uppercase, or the two
  levels read as one thing twice. The card's border went `#777` to `#525252`
  for the same reason: a dozen bright outlines stacked were the loudest
  structure in the panel, and it is the *fill* that groups. **It has since
  gone entirely**, along with the rail buttons' -- the line kept getting
  quieter because the honest answer was that it was never doing the work. The
  rail's shape survived the loss: the open button is filled with the
  *settings'* colour and the closed ones with the ground behind the panel, so
  the join that used to be a missing border segment is made by the fill.
- **The help area** is the fixed strip under the panel that describes whatever
  is pointed at. `src/help.tsx` is the mechanism (`useHelp`, `<Help id>`,
  `HelpArea`), `src/helpText.ts` is every description in one place, keyed by
  config key or a dotted id like `drums.accents`. `Input` looks up its own key,
  so a field gains help just by an entry existing.
  - **Attach with `onFocusCapture`, never `onFocus`.** `useFocusedValue`
    already puts `onFocus` on the text fields to keep half-typed text; a second
    one spread over it silently breaks editing. `useHelp()` returns the capture
    form for exactly this reason.
  - **Which entry is showing lives inside `HelpArea`**, reached through a
    stable function, so pointing at things never re-renders the tabs. **`App`
    provides it, not `Panel`** -- the top bar is outside the panel and its
    controls carry entries too, so the provider has to sit above both. The
    area itself is still the panel's, and goes when the panel does.
- **The top bar** (`src/TopBar.tsx`) is the transport, the tempo, the looper,
  where the cycle has got to, the input level and the latency.
  - **Above the panel *and* the canvas, which is the whole reason it exists.**
    Clicking a pane hides the panel; while the transport lived in
    `PanelHeader` that meant asking for more picture also took away the
    ability to stop.
  - **No input meter, and no latency figure**, though the mockups draw both.
    The meter was built and then removed on the owner's question: what is the
    point of it, when the input is already drawn across the whole canvas? A
    meter earns its place where nothing else shows you the signal, and the
    premise here is the opposite -- it was a worse copy of the thing filling
    the window, reasoned from generic audio-app convention rather than from
    this app. The one thing it could say that the canvas cannot is that input
    is arriving **while paused**, when no visual samples are produced; the
    setup wizard's microphone check already answers that, per channel. The
    latency figure could only ever print `bufferCompensation` back -- set in
    Setup, never moving on its own -- so it read as live among readouts that
    are.
  - **The beat readout is written straight into the DOM**, the rule
    `showFrameTime` already follows: it moves a hundred times a second, and a
    readout re-rendering `App` at that rate would cost more than what it
    reports. Flushed about four times a second, because a number changing
    every frame is not a readout.
  - **It reads the cycle through `cycleSteps`**, which already existed and
    already said it was the one place the order is read -- so the readout and
    the section list cannot disagree about what is going to play. `stepAt` is
    the only new arithmetic, and the beat needs no reduction because the audio
    thread restarts it at every wrap.
  - **A section is named by its number**, because a `Section` has no name. The
    honest thing to print, rather than inventing one.
  - **The tempo keeps its expression field and gains no stepper.** A `+`/`-`
    has to know what to add, and the field may hold `t` or `bar*20`; there is
    no honest answer for incrementing one of those, and rounding to a number
    would throw away the parameter the tempo was written against.
  - **`get_input_levels` reports the peak *since the last call***, so two
    pollers split the peaks between them and both read low. Worth knowing
    before anything else starts reading it: the wizard's microphone check is
    the only caller now, and should stay that way unless a second one can be
    made exclusive with it.
  - **Tooltips (`title=`) were replaced by help** wherever they explained
    something. The ones left name a value or a glyph ("Volume 70%", "Remove
    kick", the ✕ and ⠿ buttons) and the ? toggle, which has to explain itself
    once the help area is hidden.
  - Shown or hidden is `punching-bag.help-visible` in localStorage -- a
    per-machine convenience, not config.
- **Every tab gets the whole `PanelProps` bundle**, not per-tab props, so moving
  a control between tabs never means rewiring what it can reach. `get` is
  handed over with one cast in `App` -- the same function, but TS cannot prove
  its inferred return equals `Config[K]`.
- **Inactive tabs are hidden, not unmounted** (`TabPanel` sets
  `display: none`). `Input` holds the text you are typing in local state and an
  expression is invalid for most of the time it takes to type, so unmounting
  would throw a half-written field away on every tab switch. Every section
  rendered on every render before tabs existed, so this costs nothing new.
- **Which tab is open is plain React state, not a config key** -- transient UI,
  kept out of presets and the session on purpose.
- `Divider` is the labelled hairline that groups settings inside one Section.
- **⌘1..⌘9 then ⌘0 open the sections, counting down the rail**, and ⌘[ / ⌘]
  step through it. Same listener as the three below, and taken the same way:
  none is a text-editing key, and ⌘0 only resets the zoom in a browser, which
  this is not.
  - **The digit is drawn in the rail button**, dim, and the accelerator is the
    button's tooltip -- both generated from the section's position, so the
    label and the key that works can never disagree. A shortcut nobody can see
    is one nobody uses, which is the whole argument for spending the pixels.
  - **Positional, which is the one part of the rail that does not scale**, and
    that was taken deliberately rather than missed. Reordering the groups
    renumbers everything and an eleventh section gets no digit at all -- but a
    mnemonic scheme collides at once (play, presets and parameters all start
    with p) and would have to be *remembered* rather than read. ⌘[ / ⌘] is why
    nothing is unreachable however long the rail gets.
  - **Opening a section also brings the panel back.** Otherwise the key does
    nothing at all whenever the panel is hidden, which reads as a broken
    shortcut rather than as a hidden panel.
  - Checked by temp test (run, then deleted): every digit and its drawn label
    agree in both directions, ⌘0 is the tenth, a section past the tenth gets
    none, and stepping wraps both ways and reaches every section exactly once.
- **⌘P pauses, ⌘L toggles looping, ⌘R rerolls every random parameter.** One
  `keydown` listener, registered once and reaching the current `set`/`get`
  through a ref -- those are new closures every render, so depending on them
  would rebuild the listener each time. All three are taken unconditionally,
  text fields included: none is a text-editing key. ⌘R checks `shiftKey` and
  bows out, because the menu's ⌘⇧R (Restart) arrives at the webview too.
- **One key reaches the transport from outside the app** -- see *The global
  shortcut*, below. Off by default, and a different combination from ⌘P.
- **The app menu carries Restart** (⌘⇧R), added to `Menu::os_default` rather
  than to a menu built from scratch -- building one drops Edit, and with it
  cut/copy/paste in every text field in the panel. `AppHandle::restart` reads
  Info.plist on macOS, so the *bundle* comes back rather than the bare binary,
  which matters because only the bundle can hold the microphone grant. The
  session is written to local storage on every config change, so settings
  survive the relaunch; `paused` doesn't, being transient.

### The global shortcut

`src/GlobalShortcut.tsx`, a switch and one accelerator field in the setup tab,
**off by default**. One action -- pause/play, the same thing ⌘P does -- so the
transport can be reached with a DAW or a score in front.

- **It needs no Accessibility or Input Monitoring grant**, which is the whole
  reason it is a switch rather than a permissions flow. Tauri 1.8.3's
  `globalShortcut` endpoint goes through `tauri-runtime-wry` to tao 0.16.11,
  whose macOS implementation calls Carbon's `RegisterEventHotKey` directly
  (`tao-0.16.11/src/platform_impl/macos/carbon_hotkey/carbon_hotkey_binding.c`).
  That is the old system hotkey API, not a `CGEventTap`, and TCC does not gate
  it. Nothing was added to `Entitlements.plist` and nothing prompts.
- **A registration failure is silent at the source, and that cannot be fixed
  from here.** `register_hotkey` returns NULL when Carbon refuses, and tao's
  `register` ignores the null and returns `Ok` anyway
  (`platform_impl/macos/global_shortcut.rs:70-83`). Worse, the commonest
  failure is not an error at all: when another app already owns a combination
  macOS simply delivers the press elsewhere. `isRegistered` only reports this
  app's own bookkeeping, so it cannot answer either. What *does* surface is a
  parse failure, a double registration, and the IPC call itself -- those are
  shown in red -- and for the rest the panel says plainly that the key may have
  gone elsewhere and counts presses, which is the only honest confirmation
  available. The *Failing loudly* argument, at the edge of what the platform
  allows.
- **A modifier is required.** The key is taken from the whole machine, this app
  included, so it fires while a panel text field has focus and the character
  never reaches the field -- binding a bare `P` would mean never typing a P
  anywhere until the switch went off. Refused rather than allowed, because the
  way out is not obvious from inside the hole.
- **The default is ⌘⌥P, deliberately not ⌘P.** `App`'s own listener bails on
  `altKey`, so whichever path macOS hands the press to, exactly one of them
  acts -- no double toggle, and no need to know whether Carbon consumes the
  event before the webview sees it.
- **localStorage, not `audio-prefs.json`.** A binding belongs to the person and
  the keyboard, so it is not a config key and must never travel in a preset --
  the device-choice argument. But the two reasons `audio-prefs.json` exists
  don't apply: nothing here is audio, and nothing here is needed before a
  window exists. `punching-bag.global-shortcut-on` / `-shortcut`, beside
  `help-visible` and `setup-step`.
- **Registrations are serialised through one promise chain**, because
  StrictMode runs the effect twice on mount and two overlapping registrations
  of one accelerator make the second fail as already registered -- an error
  shown over a binding that is in fact working.
- A Carbon hotkey dies with the process, so a stale system-wide grab cannot
  outlive the app. It is still released on unmount and when the switch goes off.
- **Not confirmed in the running app.** The registration path, the storage and
  the StrictMode ordering are temp-tested against a mocked
  `@tauri-apps/api/globalShortcut`; what no test can say is whether the press
  actually arrives when another application is frontmost, whether macOS
  swallows it before the webview's own `keydown`, and whether ⌘⌥P is free on a
  real desktop.

## Parameters and expressions

`parameters: {name, value}[]` in `defaultJsConfig` is a global list of named
numbers, and several view fields hold arithmetic over them instead of literals.
With `n = 16, bar = 4`, a pane's rows read `bar/n x n` (0.25 x 16) and a grid
reads `{n/bar}:1` (4:1) -- so "switch to 16ths" is one edit rather than five.

`expression.ts` is the whole language: numbers, parameter names, `+ - * / ( )`,
and `min` / `max` / `round`. Every entry point **throws** rather than returning
NaN or a partial result; callers use the throw to decide between committing and
keeping the last good value. Deliberately not a scripting language.

- **Expression-backed fields are stored `{inputText, val}`** -- the same shape
  as `Rhythm`, so the recursive `unwrapValues` already strips them to `val` and
  they cost nothing on the Rust side. Per-view: `beatsPerRow`, `marginLeft`,
  `marginRight`, `visualGain`. Rust-side: `bpm`, `beatsToLoop`, `loopEchoes`,
  `loopEchoGain`, `clickVolume`, `audioInGain`, `bufferCompensation`,
  `fileVolume`, `fileBeats`, `fileOffsetMs`, `fileShift` (see `RustExprKey`). Read them through `exprNumber` / `exprList` / `viewRowBeats`,
  never directly. Sliders and dropdowns keep plain numbers -- there's nowhere to
  type an expression.
- **Rhythm text takes bare parameter names**, no braces. Both generated PEG
  grammars already reserve `+ - * / ( ) [ ]` and evaluate them (`1/5` parses to
  a span of 0.2, `2*3` to 6), so a parameter only has to become its value before
  parsing and the grammar does the arithmetic. `substituteParams` leaves
  identifiers it doesn't know alone, which is what keeps parser2's sound letters
  working -- and is why `h`/`k`/`r`/`s` are reserved parameter names.
  `resolveRhythmText` runs braces first, since `min`/`max`/`round` have no
  equivalent in the grammars. Grid, click and drum rhythms all re-resolve.
- **The Rust side has to be re-resolved *and* pushed.** Nothing in the frontend
  reads those keys -- they exist only to reach the audio thread -- so a stale
  `val` would sit there until some unrelated setting change happened to push
  again. `setParameters` calls `resolveRustConfig` and `updateRustConfig`
  alongside the js update; `loadPreset` and the restored session do the same.
- **A validator failing is treated exactly like a syntax error**: red, not
  applied, last good value kept. `resolveNumber` takes the same validator, since
  a parameter change is a path the input component can't see. This matters most
  for `bpm` -- `n - n` would otherwise push a 0 across, and `get_loop_spacing`
  divides by it, giving infinity, which `as usize` saturates to `usize::MAX` and
  panics at the allocation. `get_loop_buffer_size` clamps to `MAX_LOOP_FRAMES`
  as the last line of defence.
- **`resolveJsConfig` is the freshness mechanism.** `val` must never be one
  render stale, since the draw loop reads it directly, so the parameter setter
  re-walks the whole js config in the *same* update. Not an effect: an effect
  that writes config is a render loop waiting to happen, and it would still
  draw one frame from the old numbers. It's also run on the restored session
  and on preset load.
- **A field that stops evaluating keeps its last good `val`** and its text.
  Deleting a parameter marks every field that referred to it invalid (red
  border, recomputed from what's on screen so it survives a blur) rather than
  blanking the pane. Renaming a parameter does *not* rewrite the expressions
  using it.
- **An expression field says what it comes to, beside itself** (`Resolved` in
  `Input.tsx`): `bar/n x n` is followed by a dim `= 0.25x16`. The field shows
  what you wrote; this shows what it means. Until it existed the only place in
  the app that resolved anything was the parameters list, which covers `n` and
  `bar` and never the field being edited.
  - **Shown only when it adds something.** A literal `4` resolves to 4, and
    printing that beside it is noise, so the readout is hidden whenever the
    text already *is* the value -- **compared with the whitespace taken out**,
    because `formatNumberList` writes `0.25x16` and `RowPerNote` writes
    `0.25 x 16`, so a plain string compare left every pane the button laid out
    reading `0.25 x 16 = 0.25x16`. A number typed another way (`96.0`, or `4`
    as a one-element list) counts as the same number too.
  - **Shown while the field is red, on purpose**, because that is when it
    matters most: the last good value is still what is playing, and the whole
    contract of an invalid field is that it goes on working. Red border, and
    beside it the number still in effect.
  - **In the list's own syntax**, via `formatNumberList`, so `= 0.25x16` is
    the text you would have typed to get it rather than a second notation to
    learn. Elided past 20 characters with the whole of it in the tooltip: 128
    numbers would push the field off its row.
  - Rounded to twelve significant figures, the same as a rolled parameter and
    for the same reason -- `= 0.30000000000000004` reads as a bug rather than
    as floating point.
  - Rhythm fields get none of this: what a rhythm resolves to is a set of note
    times, which is a picture rather than a number. That is the dot strip, and
    it is not built.
- **`x` is reserved**, and so is `x` followed by digits: `formatNumberList`
  writes `0.25x16` with no spaces, so the tokenizer has to split `x16` rather
  than read it as an identifier. `min`/`max`/`round` are reserved too.
  `isValidParameterName` is the one place a user can hit this.
- **A fractional repeat count rounds**, it doesn't reject -- `bar/n x n/2` at
  `n = 7` wants 3.5 rows, and rejecting would flash the field red at every
  intermediate value of a parameter sweep. `MAX_LIST_LENGTH` still caps at 128.
- **`x` repeats a *group*, not only a number.** `[.6,.4]x8` gives sixteen
  entries alternating, and groups nest: `[[.6,.4]x2, 1]x3`. A bracketed group
  is parsed by exactly the same rules as a whole field -- `parseTokenList` is
  the single implementation, used for both -- so expressions and parameters
  work inside one (`[bar/n, .4]x2`). `[` and `]` are ops in the tokenizer and
  `splitTop` counts their depth alongside parentheses.
- **A parameter can be a list**: `divs = .6,.4`, then `rows: divs x 4`. A bare
  list parameter stands exactly where a group would. `Params` is
  `Record<string, number | number[]>` and `Parameter.value` was **widened**
  rather than renamed -- unusually safe here, because a saved session's plain
  number is still a valid value, so restore merges it over the default and
  nothing changes meaning. The one place widening is not enough is a scalar
  context: `evaluateTokens` throws `"divs" is a list` rather than guessing at
  the first element or the length, and `divs*2` is an error in a list field too
  -- arithmetic on a list has no meaning here.
- **A list parameter substitutes into rhythm text as its comma-joined values**,
  which is exactly a group body in both grammars, so `[divs]:1` becomes
  `[0.6,0.4]:1` and works. Anywhere else in a rhythm it will fail to parse,
  which surfaces as the field going red with its last good value kept.
- **A parameter may be an expression over the other parameters**, in any order,
  so long as the references form a **DAG**. `resolveParameters` enforces that
  without building a graph: each pass resolves every parameter whose references
  are already resolved, and when a pass resolves *nothing*, whatever is left is
  a cycle, depends on one, or names something that doesn't exist. Same answer a
  topological sort gives, with no graph, no visited set and no recursion.
  `parameterValues` is now `resolveParameters(...).values`, so every existing
  caller -- session restore, `setParameters`, `loadPreset`, `resolveJsConfig` --
  picked this up unchanged.
- **A failed parameter contributes nothing, not its cached value.** Falling back
  to the cache would let a cycle appear to work off stale numbers, which is
  worse than an error. Fields referring to it go red and keep their own last
  good values, exactly as when a parameter is deleted.
- **A cycle is rejected where it is typed**, not stored and then reported: the
  editor resolves a *candidate* list on each keystroke and commits only if this
  parameter resolves in it. `referencedNames` then separates "circular
  reference" from "unknown parameter zzz" in the message -- the same failure to
  an evaluator, completely different things to fix.
- **`Parameter` gained an optional `inputText`** rather than becoming
  `{inputText, val}`. Optional means a session written before this loads with no
  migration at all: its `{ name, value: 4 }` is already valid, and
  `parameterText` derives the text from the value. `resolveJsConfig` writes the
  resolved value back into each parameter, so `b = a*2` doesn't keep showing the
  old product wherever `value` is read directly.
- **Scalar is tried before list** when evaluating a parameter, because
  `parseNumberList("4")` is `[4]` -- a one-element *list* -- so the other order
  would quietly turn every literal into one.
- **`MAX_LIST_LENGTH` counts group members**, so `[1,2]x64` is exactly at the
  cap and `[1,2]x128` is rejected.
- **`beatsPerRow` changed shape** from `number[]` to `{inputText, val}`, which
  is the `loopFeedback` trap above: restore merges a saved array *over* the new
  object and `Math.max(...beatsPerRow)` returns NaN, drawing a blank pane.
  `normalizeView` wraps arrays (and bare numbers, for the three scalar fields)
  explicitly, and `migrateRust` does the same for the Rust-side keys. Wrapped
  rather than renamed, so saved layouts and tempos survive.
- **A parameter can be a roll**: `choose(1,2,3)` picks one of the values,
  `range(1,3)` picks a number between them, and `range(1,3,0.25)` picks one of
  the multiples of the step -- a tempo in whole bpm, a shift in 16ths. They are functions in
  `expression.ts` like `min`/`max`/`round`, except that they take an `Rng`
  argument rather than reaching for `Math.random` -- which is what puts *when* a
  roll happens under the caller's control.
- **A stepped `range` draws uniformly over the steps that fit**, rather than
  rounding a continuous draw: rounding gives the two ends half the weight of
  everything between them, which is visible in a set as small as `range(1,3,1)`.
  A step that doesn't divide the span stops short rather than overshooting the
  high end, and the result is put through `toPrecision(12)`, since a tempo of
  `1.3000000000000003` reads as a bug wherever it is printed.
- **A roll is sticky, and that is the whole design.** The random parameter's
  stored `value` **is** its value: `resolveParameters` does not evaluate the
  text at all unless asked to roll. Everything here is re-resolved on every
  keystroke, every preset load and every `resolveJsConfig`, so a live `choose()`
  would re-roll on all of them and no number in the app would hold still. As a
  consequence a roll is written to the session and comes back the same at
  launch, which is what you want from a setup you liked.
- **Nothing needs to know what a random parameter feeds.** A reroll writes the
  new draw back as the parameter's `value` and then goes through `setParameters`
  like any hand edit, so `b = a*2`, every view field and every Rust-side
  expression re-derive on the same update. `rollParameters(list, pick)` is the
  whole mechanism; `reroll()` in `App.tsx` is one line.
- **A random parameter is a DAG leaf when it isn't being rolled**, since its
  text is never evaluated -- so `a = range(1, n)` resolves in the first pass
  whatever `n` is doing. At *roll* time it is an ordinary node and `n` must
  resolve first, which is why a cycle through a roll is still reported as one.
- **`choose`/`range` throw everywhere except a parameter.** Without an rng
  `evaluateTokens` reports `choose() only works in a parameter` rather than
  producing a number, because a field is re-resolved constantly and would draw a
  new value every time. Same reason the roll is sticky, one level up.
- **The editor rolls to validate, and rolls on commit.** `accepts` resolves the
  candidate list with `roll = () => true`, or a half-typed `choose(1,2` would
  never be parsed by anything and so would never go red. And committing text
  whose *text changed* rolls it, since the row would otherwise show whatever the
  parameter was before -- a number that need not even be one of the choices.
- `isRandomText` tokenizes rather than matching the word, so a parameter called
  `chooser` isn't mistaken for a roll. `choose` and `range` join `x`, `min`,
  `max`, `round` and the sound letters as reserved parameter names, and are
  skipped by `referencedNames` like the other functions.
- **Drum `gains` takes expressions; `offset` and `shift` still don't.** The rule
  is the same one as before -- a nested field may only take an expression once
  it is in `resolveRustConfig`'s walk, or a parameter change leaves `val` stale
  in the one config nothing on this side re-reads. `gains` was added to that
  walk and then made expression-backed, in that order. `offset` and `shift`
  aren't in it, so they stay literal: add them first, then change them.
- **Gains went `number[]` -> `NumberListExpr | number[]`**, which is the
  `beatsPerRow` shape change again and is handled the same way -- `normalizeGains`
  wraps a bare array rather than renaming the key, so every saved drum part
  survives. Unusually, the migration needs no entry in `migrateRust`: the
  wrapping happens inside `resolveRustConfig`, which every path into the config
  already runs (startup, `setParameters`, `loadPreset`), and `exprList` in
  `drumGains` covers anything that slips past. `unwrapValues` was already
  recursive for the nested rhythm, so Rust still receives a plain `Vec<f64>` and
  is untouched.
- `drumGains` is the values, `drumGainsText` is what the field shows -- the text
  as typed where there is one, so `1, g x k` survives a render instead of being
  reformatted into its current numbers.

### Presets, and the second file store

`presets.json` in the app config dir, beside `audio-prefs.json`.
**`docs/presets.md` is the long version** -- the format, the three-case import
rule, and what a preset cannot carry.

- **They moved out of localStorage**, which is a WebKit database inside the app
  container: readable by nothing and reachable by nobody. The config dir is the
  directory the app already asks people to be able to look at, and
  `audio-prefs.json` is the precedent for putting a legible file there.
- **The session did not move, and must not.** It is written on every config
  change -- every keystroke in a text field -- and has no business being a
  file. localStorage is exactly right for it.
- **Migration leaves the old store in place.** `tpb.presets.v1` is read once,
  when `presets.json` does not exist yet, and never cleared. The cost is a
  stale copy nobody reads; the cost of the alternative is somebody's presets if
  anything about the move goes wrong, including running an older build
  afterwards.
- **Rust moves text and nothing else.** `presets.rs` has no idea what a preset
  is: the format, the migrations and every judgement about validity stay on the
  frontend next to the config types. Writes go through a temp file and a
  rename, because this is now the only copy -- `audio-prefs.json` can afford a
  half-written file and this cannot.
- **A corrupt store is moved aside, never replaced.** Refusing it would leave
  the app with no presets, and the next ordinary save then writes an empty one
  straight over everything. `quarantine_presets` renames it to
  `presets.corrupt-<stamp>.json` and the panel says where it went. This is a
  deliberate *break* from `audio-prefs.json`, where unreadable means defaults
  and the worst case is re-choosing a microphone.
- **A corrupt entry inside a good import file is skipped, not fatal.** Nine
  readable presets out of ten are worth having.
- **An array with the name as a property, not a map keyed by name.** The map
  had nowhere to put metadata, and `created` / `lastUsed` are what the sort
  orders and the duplicate detection are built on. It also makes duplicate
  names *within* one file representable, which import handles as an ordinary
  collision.
- **`version` exists in the first file ever written.** A format with no version
  has nothing for a migration to key off, which is the `loopFeedback` lesson
  one level out.
- **An `id` and a content hash answer different questions.** The id is stable
  across edits ("the same preset, changed"); the hash is stable across renames
  ("the same settings, another name"). Import tests id, then hash, then name,
  which is what keeps re-importing your own edited preset from growing a pile
  of `groove (1)` … `groove (7)`.
- **The hash is computed, never stored.** A stored hash is wrong the moment a
  preset is edited -- a derived value that can go stale is the trap the
  expression fields' `val` rules exist to avoid. It canonicalises key order
  first, or a config built fresh and one restored from JSON would never match.
- **File IO goes through Rust commands rather than the `fs` API**, whose
  allowlist scope is `$RESOURCE/*`. The paths come from a native dialog, which
  is the same trust `load_drum_sample` and `set_mp3_buffer` already run on.
- **`yarn start` falls back to localStorage**, under its own key, on an
  explicit `__TAURI_IPC__` presence check. Deliberately not a try/catch around
  the command: a command *failing* in the real app must not silently split the
  store in two.
- **A missing file names its full path**, where `drumLabel` shows the basename
  everywhere else. A preset from another machine points into somebody else's
  home directory, and the question a missing sample raises is *where it
  looked*. `decode_audio_file` names the path in its error for the same reason.
  Neither breaks the config push: both commands return `Result`, so this is a
  failed command rather than a rejected `set_config`.

### Built-in examples

`src/examples.json`, `src/examples.ts` and `src/ExampleBar.tsx`: read-only
presets bundled with the app, each teaching one idea, in their own picker above
the presets. `docs/approachability.md` has the list they are being built
towards and why examples come before a tour.

- **They load through `loadPreset`**, so they inherit everything a preset load
  already guarantees: merged over the *defaults* rather than over what you have,
  and `bufferCompensation` carried across, so an example can never overwrite a
  measured latency.
- **The store is an ordinary preset *file* with two extra fields per entry**
  (`description`, `tryThis`), which is what makes authoring one the same act as
  saving one. It goes through `parsePresetFile` like any other, so an example
  bundled today keeps loading after a key is renamed -- `migrateRust`,
  `migrateViews` and `pickKnownKeys` all apply. The two teaching fields are not
  part of a preset and that parser drops them, so `examples.ts` reads them back
  off the raw entry by id.
- **Never written by hand.** A hand-written preset is the `audioSubdivisions`
  trap -- a `val` that is not what its `inputText` parses to -- and nothing in
  the app would catch it. Build it in the app, save it, export it from
  *Manage…*, then `yarn example:add exported.json`. The two that shipped first
  were generated from the real defaults through the real parsers (and
  `rowPerNotePatch`, so the 16ths example is exactly what the button writes) by
  a temp test that also checked every `val` against a re-parse of its text.
- **`yarn example:add` matches an existing entry by id and then by name**, so
  re-exporting an example you have edited updates it in place and keeps its
  description. Ids are stable slugs rather than the app's random preset ids,
  because the descriptions are keyed by them -- the `loopFeedback` rename rule,
  one level out. It drops `lastUsed`, and warns about the three things an
  example may not do: a drum voice that is not a built-in kit sound, a
  `filePath`, and no description.
- **The "try this" line goes away by itself**, when the config stops hashing
  equal to what the example loaded. The baseline can only be taken in an effect
  -- `onLoad` sets state, so the settings are still the old ones for the rest of
  the click that asked for them -- and clearing it stops the hashing, so it
  costs nothing once it has fired.
- **Not collapsed, unlike Presets and Parameters.** The one part of the panel
  whose whole job is to be found by somebody who has just opened the app.

## Rhythm syntax

Only ever documented in a comment at the top of the generated `parser2.js`, so
it's written out here. Everything defaults to **parser2**; nothing creates a
parser1 rhythm any more and there's no UI to switch, so parser1 is effectively
legacy (it returns a flat array of times rather than `{notes, start, end}`).

| Written | Means |
|---|---|
| `4` | one note, span of 4 beats |
| `2:1` | 2 evenly spaced notes across 1 beat |
| `5:1` | 5 across a beat -- 16ths against a 4-beat bar |
| `1/5` | one note, span of 0.2 -- **the grammars do arithmetic** |
| `[2:1, 1]:1` | a group; entries share the span given after the `]` |
| `[k 1, h 1]:1` | sounds: a letter (`h` `k` `r` `s`) then a weight |
| `[h 1>-.1]:1` | `>` nudges that note's time -- lands at 0.9, not 0 |
| `[[k 1>-.1, h 1, s 1]:1, 3:1, 1]:1` | groups nest |
| `[k 1, h 1]x4` | repeat the group four times |
| `[k 1, h 1]x4:1` | repeat, *then* squish the whole run into one beat |

- **`x` repeats a group, and it is a *different* `x` from the one in number
  lists.** They look alike and are two languages: `parseNumberList` handles
  `beatsPerRow`, `rowColorPattern` and drum `gains`; the PEG grammar handles
  rhythms. `[.6,.4]x2` in a rhythm field used to fail with `Expected ":" or end
  of input but "x" found` for exactly that reason. The grammar now has a
  `Repeat` rule, and `Squish` takes `(Repeat / Group)` so `[k 1, h 1]x4:1`
  repeats *then* squishes -- eight evenly spaced notes in one beat.
- **A fractional repeat rounds** here too, matching `parseNumberList`, but a
  count below 1 is an **error** rather than an empty rhythm. `end: 0` is a shape
  nothing downstream is written to survive, and this grammar could not produce
  one before; erroring leaves the field red with its last good value, like any
  other syntax error.
- **A zero-length rhythm is a syntax error**, not a value. `"0"`, `"4:0"`,
  `"0:1"` and `"1/0"` used to parse into notes at NaN, which is `null` over IPC
  and unloadable by serde -- see *Failing loudly*. Same treatment as a repeat
  count below 1, and for the same stated reason.
- **`parser2.js` is generated and regenerating it is now a one-liner.**
  `yarn build:parser` runs `scripts/build-parser.mjs`, which uses `peggy`
  (a devDependency as of this change) with `format: "bare"` -- that is why the
  file reads `export default (function(){...})();`, the same shape it always
  had, so nothing importing it changes. The syntax documentation lives in the
  script's header constant so it is regenerated alongside the parser rather than
  drifting from it. Checked by replaying 19 existing rhythms through the old and
  new parsers: byte-identical output on every one.
- **`+ - * / ( ) [ ]` are all grammar tokens and are evaluated natively.** That
  is why parameters need no braces in a rhythm field (see Parameters and
  expressions) -- substituting the name is enough and the grammar does the rest.
- **Nothing reads `sounds`.** The Rust `Note` struct has the field commented out
  and the draw code only uses `note.time`, so the letters parse and are then
  discarded. They're reserved as parameter names anyway, to keep the syntax
  usable if a sound ever gets wired to a drum voice.
- The default `audioSubdivisions` has `inputText: "2:1"` but a hand-written
  `val` carrying `sounds: ["h"]`, which is *not* what that text parses to.
  Harmless while nothing reads sounds; misleading the moment something does.

## macOS packaging and permissions

**The bundled app and the bare binary do not have the same permissions.**
Running `target/release/tauri-punching-bag` from a terminal works because
Terminal is then the responsible process for TCC and the child inherits
Terminal's microphone grant. The `.app` has to earn its own, and three things
were stopping it:

- **`NSMicrophoneUsageDescription` was missing entirely.** Without that string
  macOS never shows the prompt, and CoreAudio returns silence rather than an
  error -- an input of all zeroes with nothing in any log. Tauri v1 merges
  `src-tauri/Info.plist` into the generated one; that file exists now solely to
  carry this key. Verify a build with
  `plutil -p .../tauri-punching-bag.app/Contents/Info.plist | grep -i usage`.
- **The hardened runtime is on** (`codesign -dv` reported
  `flags=0x10002(adhoc,runtime)` then, `flags=0x10000(runtime)` now that the
  signature is real), and under it a process cannot open an input device
  without `com.apple.security.device.audio-input`. It was commented out. The
  hardened runtime is also a precondition for notarization, so it stopped being
  optional.
- **`com.apple.private.tcc.allow-prompting` was the only entitlement applied.**
  That is an Apple *private* entitlement; third parties can't use it, it did
  nothing here, and it would make a real Developer ID signature invalid. Removed
  -- don't put it back.

### Signing and notarization

**Signed with a Developer ID and notarized, as of 2026-09-12.** This replaced
ad-hoc signing, which was the reason other machines were hard: TCC keys a grant
to the code signature, an ad-hoc signature changes every build, and Gatekeeper
blocks an ad-hoc un-notarized bundle outright.

- **`signingIdentity` is `"Developer ID Application: Eric Vogler (9KMDH5UH9Z)"`**
  in `tauri.conf.json`, and the team id is the certificate's OU -- read it with
  `security find-certificate -c "<name>" -p | openssl x509 -noout -subject`
  rather than from the parenthetical in the identity string, which is a
  different number on a development certificate.
- **Tauri v1 notarizes the `.app` and not the disk image it then builds around
  it.** The app's own ticket is stapled, so it launches; the image carries a
  signature and no ticket, and the image is what Gatekeeper judges *first* on a
  download -- it refuses to mount one with "Apple could not verify this is free
  of malware". `scripts/tauri.mjs` submits and staples the image after a
  successful build, and says loudly when it could not rather than failing a
  build whose app is fine. Stapling both also means neither check needs the
  network.
- **Notarization needs `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` in the
  environment**, and the password is an *app-specific* one from
  appleid.apple.com, not the account password. Without them the bundler logs
  `skipping app notarization` and carries on succeeding, so the absence is
  quiet. `scripts/tauri.mjs` loads them from a gitignored `.env.signing`; an
  exported variable wins over the file. Check the credentials in a second
  without a build: `xcrun notarytool history` answers `No submission history`
  when they are right and an auth error when they are not.
- **`@tauri-apps/cli` had to go 1.0.5 -> 1.6.3 first.** 1.0.5 shells out to
  `xcrun altool`, which Apple retired on 1 Nov 2023, so notarization could not
  have worked at all. Still Tauri v1 and no code migration: the Rust crate was
  already resolving to 1.8.3 and only the JS CLI was stale. `strings` on
  `node_modules/@tauri-apps/cli-darwin-arm64/cli.darwin-arm64.node` names which
  tool a given CLI will call.
- **The private key cannot be re-downloaded and Apple caps how many Developer ID
  certificates you may hold.** Export it as a `.p12` and keep it. Losing it
  means a new signature, which means every machine treats this as a different
  app again and every TCC grant is void.
- **A stale TCC record survives all of this**, keyed by the bundle id. After
  changing the signature, `tccutil reset Microphone com.vogler.dev` is what
  makes the prompt appear again.

### Updates

`updater` in `tauri.conf.json`, `src/Updater.tsx` for the manual half, and a
`latest.json` written by `scripts/tauri.mjs`. Aimed at friends rather than at
the machines you own: you cannot walk over to someone else's Mac, and nobody
chases a new disk image.

- **A second keypair, unrelated to Apple's.** The Developer ID proves to *macOS*
  that the app is from you; this minisign key proves to *the app* that an update
  is from you. `tauri signer generate -w ~/.tauri/punching-bag.key`; the public
  half goes in `updater.pubkey`, the private half stays out of the repo and its
  password lives in `.env.signing` beside the Apple credentials.
  - **Losing it is worse than losing the `.p12`.** Every existing install
    rejects every future update, permanently, and each machine needs a manual
    reinstall to get back on the train. Back it up.
  - **Stealing it is worse still**: it signs code that auto-installs on other
    people's machines. It is the one secret here that is worth a password.
- **The version has to actually move.** The updater compares `package.version`
  against the manifest and does nothing when they match -- silently, which reads
  as a broken endpoint. Bump it in `tauri.conf.json` (and `package.json`, kept
  in step) as part of releasing, not after.
- **The endpoint is GitHub Releases**, which works only because the repo is
  public: v1's `UpdaterConfig` takes `active`, `dialog`, `endpoints`, `pubkey`
  and `windows` and **no headers**, so there is no way to authenticate to a
  private one -- a token would have to sit in the URL, baked into the binary.
  Going private means a static host instead, or Tauri v2, whose updater plugin
  does take headers.
- **`dialog: true` and the manual check are independent paths**, and the flag
  gates only the first. The launch check runs `prompt_for_install`; a JS
  `checkUpdate()` is picked up by a listener that never reads `dialog` at all.
  So both work at once, and the manual path raises no native dialog -- which is
  why `Updater.tsx` renders its own line rather than reusing one.
  - **The dialog path installs *and* asks to restart; the JS path does neither.**
    It emits `DONE` and returns, so an update installed from the panel would sit
    on disk unmentioned until the next launch. `Updater.tsx` calls `restart_app`
    itself -- the same command the menu's Restart uses, so the *bundle* comes
    back rather than the bare binary.
- **An updater failure is silent by construction**: the app goes on working
  perfectly and simply never updates again. `onUpdaterEvent` is listened to for
  exactly that reason -- the *Failing loudly* argument, one layer out. The error
  is shown in the updates section rather than the config banner, because the
  launch check fires it every time the machine is offline.
- **`scripts/tauri.mjs` writes `latest.json` and prints the publish commands
  rather than running them.** Publishing is the step that puts code on other
  people's machines; it stays something you do on purpose. A tarball with no
  `.sig` beside it means the key vars were not set, and it says so instead of
  writing a manifest the updater would reject.
- **It prints two commands, not one, and always passes `--notes`.**
  `gh release create` with assets attached goes *interactive* when notes are
  missing, and that path uploads every asset twice -- which fails with
  `ReleaseAsset.name already exists`, blaming a duplicate that does not exist on
  disk, and then rolls the whole release back. Splitting create from upload also
  lets `--clobber` make a half-finished upload re-runnable. Hit once, on the
  first publish attempt.
- **Publish the artifacts from one build.** Every build produces a fresh tarball
  and a fresh signature, so a manifest from one build with a tarball from
  another verifies on nobody's machine. Rebuild, and re-copy all three.
- **The platform key is derived, not typed** (`darwin-aarch64`). The updater
  matches it exactly, and an x86_64 or universal build needs its own entry.
- **`notes` comes from the last commit subject, so commit before building a
  release.** Build first and the release notes describe the commit *before* the
  work being released -- which is wrong in a way nobody would notice until a
  friend read them. Editing `latest.json` by hand before publishing is the other
  answer.

Verified 2026-09-13, on the first updater-enabled build: the minisign signature
in `latest.json` checks out against the public key in `tauri.conf.json` for
exactly that tarball (both the signature and the trusted comment's global
signature, Ed25519 over a blake2b-512 prehash), the key ids match, and the
`.app` *inside* the tarball is 0.2.0, hardened, `TeamIdentifier=9KMDH5UH9Z`,
`accepted` by `spctl` as a Notarized Developer ID and stapled -- so it clears
Gatekeeper offline once the updater swaps it in.

**The round trip is confirmed, 2026-09-13.** v0.2.0 was published and installed
on the work Mac; v0.2.1 was published; the app raised the native dialog on
launch showing v0.2.1's release notes, installed on yes, and came back as
v0.2.1 -- **with audio still working and no new microphone prompt.** That last
clause is the part worth keeping: it is the payoff of the Developer ID being
stable, and it is a *stronger* result than the rebuild test it settles, because
the bundle was replaced wholesale by a build from another machine and the grant
still held.

### The App Store, if it ever happens

Updates would go through the store and the updater above would have to come
*out* -- App Store apps may not download and run new code. The real cost is the
**sandbox**: the microphone entitlement carries over, but arbitrary file paths
do not, so the file player and the drum samples would need the user-selected
entitlement plus security-scoped bookmarks saved with the session. `filePath`
surviving a restart is exactly what a sandbox forbids. That is the same work the
AU port needs, so it would be done once for both. Different certificates and a
second build target on top.

### Installing on a second Mac

**The build now sweeps stale disk images, so there should only ever be one.**
`bundle/dmg/tauri-punching-bag_0.1.0_aarch64.dmg` is the release artifact.

This used to be a real hazard. A rebuild never cleaned up after itself, so old
images sat in the tree looking like build outputs indefinitely -- the bundler's
`bundle/macos/rw.*_x64.dmg` scratch image from **March 2023**, and a **November
2022** `x86_64` build under `target/debug/bundle/dmg/` whose name was *identical*
in shape to a real artifact. Shipping one by mistake produced an app that first
refused to launch and then, once launched, captured nothing -- no microphone
prompt, no entry in Privacy & Security, silence with nothing in any log. Every
one of those symptoms is *also* what a correct build looks like when Gatekeeper,
TCC, or the sample rate is wrong, which is why it survived several rounds of
plausible fixes aimed at the wrong thing.

- **`yarn tauri` runs `scripts/tauri.mjs`, not the CLI directly.** It forwards
  every argument untouched and only sweeps after a `build` that *succeeded* --
  a failed build is left exactly as it fell, so there is something to look at,
  and so a transient `bundle_dmg.sh` failure can't take the previous good
  artifact with it. `yarn tauri dev` is unaffected.
- **The sweep is by time, not by name.** Any `.dmg` under `src-tauri/target`
  older than the moment the build started is from some other build and goes.
  The `rw.` prefix is only the case we happened to know about; the image that
  actually cost a day was named exactly like a real one, which a name pattern
  would never have caught.

### The disk image step

`bundle_dmg.sh` reports exactly one thing, `error running bundle_dmg.sh`, for
every way it can fail. Run the CLI directly to see the real error --
`node_modules/.bin/tauri build --verbose`, which prints the shell trace and so
the `hdiutil` line that actually failed. Two causes, and the second is the one
that costs a day.

**A mounted volume of the same name.** The script creates
`/Volumes/tauri-punching-bag` and cannot when that name is taken. Its `rw.*.dmg`
scratch image stays attached after a failed run, so one failure makes every
later one fail for a *different* reason than the first -- which is why this
reads as transient and is not. The way it gets genuinely stuck is the app
*running* from the mounted image: `hdiutil detach` then answers `Resource busy`
and no amount of re-running will ever clear it. `lsof +D /Volumes/...` names the
process.

`scripts/tauri.mjs` frees the name before a build, and **refuses to build when
it cannot** -- the disk image is the last step, so otherwise you pay the
compile, the signing and a notarization round trip to arrive at a failure that
was knowable at the start.

- **The volume is identified by name, not by its backing image.** Matching only
  images under `src-tauri/target` misses the case that actually bit: *any* copy
  of a released disk image, mounted from anywhere -- Downloads, a USB stick,
  whatever was being carried to another machine -- claims the same name. An
  image under `src-tauri/target` is additionally swept whatever it is called,
  which is the scratch-image case.
- Verified both ways by mounting an image from outside the target tree: it is
  detached and the build proceeds, and when a process holds the volume the
  build is refused with the holder named.

**App Management, once the app has been launched from a disk image.** The real
error is

```
could not access /Volumes/tauri-punching-bag/tauri-punching-bag.app - Operation not permitted
```

and it is macOS TCC (`kTCCServiceSystemPolicyAppBundles`) refusing *any* write
to that path -- `ditto` is refused identically, so it is not an `hdiutil`
problem. **Grant App Management to the terminal** that runs the build (System
Settings → Privacy & Security → App Management; it was Ghostty here, and the
grant took effect without restarting it).

- **It is keyed to the exact path, which is what makes it so confusing.** Three
  runs pin it down: the same volume name with a plain folder works, the same
  volume name with the app renamed to `renamed.app` works, and only
  `/Volumes/tauri-punching-bag/tauri-punching-bag.app` is refused. Protection
  attaches to that path because an app was once launched from it -- the
  provenance record behind the `putting executable into provenance` message
  below.
- **So it appears only after someone mounts the DMG and runs the app**, which is
  exactly what testing the artifact involves. It will keep coming back on any
  machine where that hasn't been granted.
- **Do not chase LaunchServices.** There *is* a stale registration for that path
  and `lsregister -u` clears it, and it changes nothing -- the protection is in
  TCC, not in LaunchServices. Nor is `tccutil reset SystemPolicyAppBundles
  <terminal>` enough on its own: it produced no prompt and no change. The grant
  has to be made in System Settings.
- The Claude Code sandbox is *not* involved. Checked with
  `dangerouslyDisableSandbox`, which failed identically.

**Identify the artifact before debugging anything else.** One command settles it:

```
codesign -dvvv /Applications/tauri-punching-bag.app
```

- `Format=... (x86_64)` -- wrong DMG. Current builds are `arm64`.
- `Info.plist entries=17` -- wrong DMG. A build carrying the microphone key has 27.
- `CodeDirectory v=20400` -- wrong DMG; current is `v=20500`.
- `TeamIdentifier=not set` -- a build from before the Developer ID. Current is
  `9KMDH5UH9Z`, and this is the strongest of the four: it cannot be faked by a
  stale artifact, because no stale artifact has it.

**Do not use file size for this.** The old note here said 7 MB versus 36 MB, and
that has inverted: a current signed build compresses to **6.8 MB** (the app is
14 MB on the volume), so the figure that used to mean "the known-bad x86_64
image" now describes a correct one. Run `codesign -dvvv`.

**The install should now be an ordinary drag**, since the bundle is notarized
and stapled: mount the image, drag the app to Applications, open it. The staple
means Gatekeeper can clear it without a network round trip, so this holds
offline too.

Everything below is the **ad-hoc era recipe**, kept because it is what to reach
for if a signature or a notarization ever regresses -- and because two of its
three "failures" were never failures at all.

```
rm -rf /Applications/tauri-punching-bag.app          # never merge onto an old one
xattr -dr com.apple.quarantine <the>.dmg             # if the image itself won't mount
ditto -R /Volumes/tauri-punching-bag/tauri-punching-bag.app \
         /Applications/tauri-punching-bag.app        # ditto, not a Finder drag
xattr -dr com.apple.quarantine /Applications/tauri-punching-bag.app
open /Applications/tauri-punching-bag.app            # then Open Anyway, possibly twice
```

On macOS 15 the escape hatch was **System Settings → Privacy & Security → Open
Anyway**, which only appears *after* a launch has been refused; right-click →
Open no longer works. Expect to use it more than once.

**Three things look like failures and are not.** All three were chased here:

- `com.apple.provenance` surviving `xattr -dr` -- a different, system-restricted
  attribute that Gatekeeper does not read. Only `com.apple.quarantine` matters.
- `unable to initialize qtn_proc` and `putting executable into provenance` in
  the log -- what syspolicyd prints for a file with *no* quarantine attribute.
  They mean the removal worked.
- `spctl -a` reporting `rejected` -- that *was* expected for every ad-hoc,
  un-notarized build, and unrelated to whether the signature was valid, so
  `codesign -vvv --deep --strict` was the question worth asking instead. It is
  no longer a false alarm: a notarized build reports `accepted` with
  `source=Notarized Developer ID`, so a `rejected` now means something really is
  wrong.

**A self-signed certificate is a free stable identity**, superseded here by the
Developer ID but still the answer if the membership ever lapses and the only
goal is running the app on a machine you control. Keychain Access → Certificate Assistant → Create a Certificate, with
**Identity Type: Self Signed Root** and **Certificate Type: Code Signing**, then
`codesign --force --options runtime --entitlements Entitlements.plist --sign
"<name>"`. `Warning: unable to build chain to self-signed root` is expected and
the signature still lands -- `Signature size=` in `codesign -dvvv` is how you
tell a real signature from `Signature=adhoc`. It does nothing for Gatekeeper,
but unlike ad-hoc it gives TCC something durable to key a grant to, so the
microphone permission survives a rebuild.

Two Keychain Access details that waste time: `security find-identity -v -p
codesigning` hides untrusted certificates, so check without `-v` before
concluding the certificate does not exist; and Get Info on the *private key*
shows only Attributes and Access Control -- the Trust pane is on the
**certificate**, the parent row under My Certificates.

## Audio thread rules

The render callback in `main.rs` runs ~21×/sec with 2048 frames. Inside it:

- **Never allocate at all, per frame or per callback.** The display buffers
  were the exception and stopped being one: `get_samples` used `mem::take`,
  which leaves a vector with *no capacity* behind, so the callback grew both
  from zero on every drain -- ~20 reallocations and a copy of the whole batch,
  on the audio thread, scaling with how many channels the panes ask for. It now
  swaps in vectors sized *before* the lock is taken, from what the last drain
  took (`DrainSizes`, atomics deliberately outside the mutex so the sizing
  can't itself make the callback wait). `MAX_VISUAL_BACKLOG` caps the buffer at
  a second so a wedged frontend can't grow it -- and with it the next reserve --
  without bound. The audio thread waiting on the allocator while the IPC thread
  holds it is the classic way a synthesised part comes out late; the whole
  point is that it never gets there.
- **The callback holds both display mutexes for its entire run**, so a drain
  only happens between callbacks. Everything the commands do inside the lock is
  therefore O(1) by construction -- a swap, never a copy or an allocation.
- **Never allocate per frame.** Rhythm time-vectors, pan gains, and drum sample
  lookups are all resolved *once per callback* into locals. The click's times
  array used to be `.collect()`ed inside the per-frame, per-channel loop — about
  88,000 allocations/sec. Don't reintroduce that pattern.
- **Per-frame vs per-output-channel.** The output loop runs twice per frame
  (stereo). Anything advancing sample time — input pops, the loop buffer, the
  beat, triggers, display pushes — belongs *outside* it. Things that legitimately
  live inside: writing `channel[i]`, the mp3 read, drum sample mixing.
- **`buffer_compensation` is in frames** (default 4330 ≈ 98 ms), hand-tuned by
  the owner and since confirmed to within 3 frames by the calibration measurement
  (see *Measuring it automatically*). Don't change its units.
- **`beat` must stay f64 end-to-end.** It counts up from launch, so at f32 the
  gap between representable values outgrows a screen pixel after ~20 minutes and
  the waveform stops being redrawn densely enough to erase the previous pass —
  ghost trails. Fixed once; don't reintroduce a cast.

### The high pass

`highPassOn` / `highPassHz` / `highPassAudio`, in the Rust config, applied per
*input channel* in the callback. The waveform is drawn nearly raw at the zoom
levels in use -- a few samples to a pixel column -- so the slow humps on screen
are cycles of a note's fundamental rather than its envelope. Transients are
broadband and a sustained note is not, so tilting the picture toward the high
end shows where notes *start*. This is the first stage of onset detection, so
it isn't throwaway work.

- **Per input, not per view.** The sample stream is packed once per frame for
  every pane, so a per-pane filter would need one filter state per channel per
  pane and a stream per pane to carry the results. It is also a property of the
  signal rather than of a ruling.
- **Two poles, and the order is arithmetic rather than taste.** A note's
  fundamental commonly sits 20-30 dB above the transient content of the same
  note, so a single pole at ten times the fundamental buys ~20 dB and the humps
  still win. The second pole buys another 20. Measured at an 800 Hz cutoff,
  against the passband: -3.0 dB at 800, -17.6 at 200, -32.1 at 82 -- a guitar's
  low E, well under its own attacks.
- **`x - lowpass(x)`, not a biquad.** One state variable per pole, one
  coefficient, and it cannot go unstable for any `k` in 0..1 -- which matters
  because the cutoff is an expression the user is halfway through typing. Both
  degenerate answers are safe *in the callback*, independent of any frontend
  validation: a nonsense cutoff gives `k = 0` and passes the signal through, and
  a cutoff past Nyquist gives `k = 1` and removes everything. Neither can
  produce a NaN.
- **`POLE_SCALE` is why the label means what it says.** Two identical one-poles
  are each 3 dB down at their own corner, so putting both at the requested
  frequency lands the pair 6 dB down there -- and `analysisBandLow`, two
  controls away, is in honest Hz. Each pole is set to `f * sqrt(sqrt(2) - 1)`
  instead, which puts the *pair* at -3 dB where the label says. Verified by
  measuring the response at three cutoffs.
- **The passband is flat but sits ~0.65 dB down**, because the complement of a
  *discrete* one-pole lowpass is not quite the ideal one-pole highpass. A level
  offset, not a tilt, so every figure above is quoted against it.
- **Both filters run whether or not the switch is on.** Turning the filter on
  mid-phrase would otherwise start it from silence and put a step into the
  picture, and into the sound if the audio is following.
- **The analyzer is deliberately left on the raw signal.** The flux already has
  `analysisBandLow` / `analysisBandHigh`, done properly in the frequency domain;
  filtering twice would make its normalisation describe something else.
- **`highPassAudio` filters the monitor and what the looper records**, so the
  filter can be heard rather than only looked at. Three frames per sample exist
  for this -- `input_raw` (the analyzer), `input_frame` (the picture) and
  `input_audio` (the sound) -- and they differ only while the filter is on.
- **The looper is the awkward part, and LTI is what resolves it.** One buffer
  serves both the echo *audio* and the echo *picture*, so with the audio left
  dry the buffer holds an unfiltered signal that the picture still needs
  filtered. A second filter over the summed echoes is *exactly* equivalent to
  having filtered before storage -- the filter is linear and time-invariant and
  the taps are plain delays, so `H(Σ g·x[n-d]) = Σ g·(Hx)[n-d]`. Simulation-
  checked to within 1e-4 over three taps. The alternative, a second loop buffer,
  costs up to 30 MB; storing the filtered signal instead would change what the
  looper sounds like without being asked.

### Speaker bleed

`bleedCancelOn` in the Rust config, `bleed.rs`, and a **measure bleed** button
in the signal tab. For practising on speakers rather than headphones, where the
click and the drums come back in through the microphone and draw bars of their
own over what you are trying to look at. Display only, off by default.

**It subtracts the waveform, and it is measured once and then frozen.** Both
halves of that were arrived at the other way round first, and the two rejected
designs are written out at the end because both look right on paper.

- **The reference is free and already delayed by the right amount.** `BusDelay`
  holds the drums, click and file for `buffer_compensation` frames so they draw
  on the beat they sounded on -- and that compensation *is* the measured round
  trip, so what it hands back is the output the microphone is returning the echo
  of now. `peek_lead` reads it without advancing, since the input loop runs at
  the top of a frame and `push` at the bottom.
- **The three synthesised buses, not the output channel.** The output also
  carries the monitor and the looper's echoes, and subtracting those would take
  your own playing out of your own trace.
- **The probe is full-band noise, not the calibration's sweep.** The click it
  has to cancel is `rng.gen()` -- white -- and a 500-8000 Hz chirp measures
  nothing about the response outside its own band. It runs at roughly the
  click's own level, because a response measured quiet does not describe a
  speaker being driven loud, which is where its nonlinearity lives.
- **Measured through exactly the path it will be inferred through.** The
  training loop peeks `bus_delay`, pushes the canceller, and only then pushes
  the probe into the delay -- the same order, the same functions. An alignment
  measured any other way could disagree with the runtime's by a few frames,
  which is the one error that is both fatal and invisible.
- **The window is biased late, not centred.** A reflection is always late --
  no room returns sound before the direct path -- so the early side only has to
  cover `buffer_compensation` reading long, while the late side has to cover it
  reading short *and* hold the whole response. `LEAD` is a quarter of `TAPS`:
  2.9 ms early, 8.7 ms late. Centring it cost a response 2.2 ms long its tail
  whenever the compensation read 1 ms long, and cancellation fell from 117 dB
  to 24.
- **It refuses rather than installing a filter it cannot stand behind**, the
  way the calibration does, and shows both measurements either way -- "nothing
  came back" and "something came back and would not cancel" need opposite
  responses. A failed run leaves the canceller switched out, and an untrained
  canceller is a pass-through, not a subtraction.
- **The audio thread asks for the verdict as a bool, never as the result.**
  `BleedResult` carries a message, and formatting one allocates -- and then
  frees the old one -- on the thread that must do neither. `passed()` is the
  numeric gates alone; the command builds the message. Same split as the
  calibration, which leaves the correlation to the command.
- **A run works while paused**, because it sits ahead of the pause check. It is
  measuring the speaker and the room, which have nothing to do with the
  transport. The calibration sits *after* that check and so quietly does
  nothing when paused -- a trap worth fixing there too.
- **`audio_in_gain` is applied to the prediction, not folded into the weights**,
  so turning the input trim up does not silently invalidate a measurement.
- **The high pass needs no special handling, by the LTI argument the looper
  already uses.** The probe is measured raw and the runtime reference is
  filtered, and `H(x - h*d) = H(x) - h*H(d)` -- so the same response is correct
  in both domains, and toggling the filter cannot invalidate a measurement.
- **The picture by default; the sound only if asked** (`bleedCancelAudioOn`,
  below). `input_raw` is untouched either way, so the analyzer always measures
  what the microphone actually heard.
- **The echo is predicted once and filtered afterwards, not predicted from a
  filtered reference.** The picture may be high-passed while the sound is not,
  and the high pass is LTI, so `H(h*d) = h*H(d)` -- one prediction, run through
  a per-channel `HighPass`, serves both domains. It is also why the probe can be
  measured raw and used under any filter setting.
- **A laptop speaker is the hardest case for the linear part.** The built-in
  output runs its own dynamic EQ and limiting, and that is a nonlinearity which
  *changes with the content* -- so the response measured against noise is not
  quite the one a click meets. The probe runs at about the click's own level to
  narrow the gap, and this is the first thing to suspect if the measured figure
  comes out low on the laptop and high through an interface.
- **It does not survive a restart**, and it should: the filter is callback-local
  and the measurement is a property of a device pair, exactly like
  `pairCompensations` in `audio-prefs.json`. ~512 floats per channel per pair.
  Not built; re-measuring takes two and a half seconds.

Simulated end to end against a modelled speaker and room (run, then deleted):
124 dB removed in the ideal case, **unchanged by loud playing over the top**,
which is the whole point of freezing it; 113 dB with the compensation 2 ms long
and a refusal at 4 ms; 30 dB with it 4 ms short; and 43 dB against a speaker
with 6% third-harmonic distortion, which is the ceiling no linear filter passes.

#### Following the path as it moves

`bleedTrackOn`, on by default. The measured filter is the prior; this is a
bounded refinement around it, never a fresh search.

- **The path really does move, and the owner found it before the code did.**
  Hands over a laptop keyboard sit 5-15 cm from both transducers and return a
  reflection a fraction of a millisecond behind the direct arrival, large enough
  to be a first-order part of the response rather than a perturbation of it.
  Measuring with your hands away and then putting them back is visibly worse.
  So is the lid angle, and where you are sitting.
- **The guard is the whole of why this is safe, and it is only available because
  the filter was measured first.** Learn only from frames where the filter
  already explains 10 dB more than it leaves behind: such a frame has almost
  nothing of *you* in it by construction. That is exactly the judgement the
  from-scratch adaptive version could not make -- with `predicted = 0` at
  startup the test is meaningless -- and it is why the same idea works here and
  had to be abandoned there.
- **Both sides of the guard must be the same statistic, and both must attack
  instantly.** A 20 ms average takes 20 ms to notice you have started playing
  and adapts hard through all of it: 880 bad updates at the top of every phrase,
  and they accumulate -- measured at **-2.6 dB against 6.4 frozen**. Fixing that
  with an instant-attack error against an averaged prediction is worse than
  useless in the other direction: peak against mean is not a comparison, the
  guard reads as though nothing is explained and never opens at all. Peak-hold
  on both, decaying over ~300 ms.
- **The NLMS denominator needs a floor, and the training path cannot show you
  why.** The step is divided by the reference window's energy, which is right
  while the probe runs because the probe never stops. At runtime the reference
  goes near-silent between one drum's decay and the next click, and a step
  divided by almost nothing is almost anything: the filter diverged, its
  residual went huge, and the guard then read the wreckage as "nothing is
  explained" and froze it there. **6.4 dB frozen against -12 dB.** A peak of the
  reference energy over the last few seconds both floors the denominator and
  gates the frame.
- **`TRACK_GUARD` is 10 by measurement, not by taste.** Over thirty seconds of
  practising against a moved path, where the frozen filter manages 6.4 dB:

  | guard | silent | bursts | loud bursts | never stops |
  |---|---|---|---|---|
  | 3 | 27.3 dB | 8.9 dB | 23.3 dB | **3.9 dB** |
  | 10 | 27.3 dB | 23.6 dB | 6.4 dB | 6.4 dB |
  | 30 | 6.4 dB | 6.4 dB | 6.4 dB | 6.4 dB |

  Three tracks in more situations and is *worse than frozen* in the last
  column. Thirty never opens. Ten either tracks or holds, and 6.4 dB is it
  declining to act. Given that the two designs before this one were both
  abandoned for making the picture worse, never-worse-than-frozen is the
  property worth buying.
- **What it costs is that loud continuous playing gets no tracking at all** --
  the guard simply never opens, and you are back to the frozen filter. That is
  the trade, taken deliberately.
- **It pulls gently back toward the measured weights** on every adapting frame,
  so "wandered somewhere strange" decays into "the filter you measured" rather
  than persisting.
- **Reporting and learning are two different bars.** `REPORT_GUARD` is 1 and
  `TRACK_GUARD` is 10: a frame where the echo merely outweighs what is left is
  one where the figure means something, while learning from it would be noisy.
  Held to the learning bar the readout goes blank exactly while you are playing,
  which is when you want to look at it -- that was the first version, and the
  owner reported simply not being able to find a live number.
- **Both bars are still gated on the echo dominating**, which is what makes the
  figure honest. The continuous-adaptation version's meter reported +2 dB where
  the truth was -9, because it averaged over everything; that is what
  disqualified it.

#### Out of the looper, not just the picture

`bleedCancelAudioOn`, off by default, applies the same subtraction to
`input_audio` -- what the monitor plays and what the looper records.

- **The looper is the reason, and what it fixes is real feedback.** The buffer
  is a plain history of the microphone, the speaker plays that history back, and
  the microphone records it again. On a laptop that path closes: `channel[i] =
  audio_out * 12.0` puts the looper through a factor of twelve on its way out,
  so a coupling of a tenth is already a loop gain above one.
- **So the reference gained a fourth bus.** `BUS_COUNT` is 4: drums, click,
  file, and the looper's feed at `loop_out * 12` -- carrying the twelve, or it
  describes a sound nobody made. The *monitor* is still deliberately excluded:
  that one is your own live playing on its way to the speaker, and subtracting
  it would take you out of your own trace.
- **Summed across the two sides, like `file_bus`.** Exact for a centred mono
  input, which is the laptop case and the case this was asked for; an
  approximation for anything hard-panned, because one probe measured one summed
  path and two speakers emitting different signals need two filters.
- **It is suppression, not a cure, and the numbers are modest.** Simulated with
  part of the response deliberately outside the filter's window, so the
  achievable cancellation is capped the way a real room caps it: the loop runs
  away above a coupling of about 0.12 uncancelled and about 0.25 cancelled.
  Roughly double the coupling, or twice the loop volume, before it goes. The
  speaker's distortion is not cancelled and feeds back on its own account.
- **What it leaves behind is a narrow band that still grows**, which is what
  *Stopping the loop running away* is for -- the two are meant to be used
  together on a laptop.
- **Alternating record and playback kills it dead instead**, by construction,
  and is the owner's own plan. The two are complementary: alternating gives up
  continuous recording -- which is what makes overlapping phrases work -- and
  this does not.
- Separate from `bleedCancelOn` because it changes what the looper *records*,
  which is the line the high pass draws too.

#### Two designs that were tried first

Both are recorded because both are the obvious thing to reach for, and the
reasons they fail are not visible until you measure.

- **Taking the magnitude down by the emitted envelope.** No phase alignment
  needed, and for a peak display it draws the same picture -- *if* your playing
  is louder than the bleed. It is not, on a laptop, and then "sink the bleed
  below the playing" and "mute the playing" are the same operation: what it
  drew was a black band at every beat with the playing gone from inside it.
  Subtracting a constant from a magnitude is a cliff, and scaling instead
  (`m / (m + duck)`) only makes the same loss gradual. The information that
  separates two sounds arriving at once is in the phase, and an envelope has
  thrown it away.
- **A continuously adapting NLMS filter.** The click is fresh white noise every
  beat, which makes it ideal excitation -- maximally persistently exciting, and
  uncorrelated with what you play. What kills it is that playing over the top is
  not an interruption here, it is the entire activity: permanent double-talk.
  Simulated across four regimes it reached 15 dB with the bleed well above the
  playing, 4 dB with them comparable, and **9 dB worse than doing nothing** with
  the playing above the bleed, where it settled into explaining part of *you*
  out of the reference. Regularising the step against the unexplained power
  helped and did not fix it; leakage did not help at all.
  - **The fatal part is that the app cannot tell which regime it is in.** Energy
    in against energy out -- the only self-check available without knowing the
    answer -- reported *plus* 2 dB where the truth was minus 9. A filter that
    can quietly make the picture worse and cannot be told that it is has no
    business running unattended. Measuring in two and a half seconds of silence
    removes the problem instead of managing it, and converges four orders of
    magnitude further besides, because the probe is continuous rather than the
    200 frames a beat a click affords.

### Input capture

- **The sample rate is the input device's, not a constant.**
  `get_input_output_channels` reads `kAudioDevicePropertyNominalSampleRate` off
  the default input device and calls `set_sample_rate` before anything derived
  is built; `sample_rate()` in `constants.rs` is the `OnceLock` everything else
  reads. **AUHAL will not convert on the way in**: point it at a 48 kHz
  microphone while asking for 44.1 kHz and it hands back zeroes -- no error, no
  log, an input of all silence indistinguishable from a missing microphone
  grant. That is why the constant had to go; a MacBook's built-in mic is 48 kHz
  out of the box, so the old code only ever worked on a device already sitting
  at 44.1. Confirmed by setting the device rate and watching the waveform go
  flat.
- **Output does convert, so when the two devices disagree the input wins.** The
  render callback advances `beat` and pops one input sample per *output* frame,
  so both sides are assumed locked to one rate. Input's rate is chosen because
  it is the side that refuses to resample; the output unit takes the ordinary
  "play 44.1 on a 48 kHz device" path. The disagreement is logged. Genuinely
  separate devices still drift -- the answer there is an aggregate device, not
  offset correction (see *Discussed but not built*).
- **A read of the rate must not decide it, and the order is load-bearing.**
  `sample_rate()` was `get_or_init(|| DEFAULT_SAMPLE_RATE)`, so *any* read
  locked the process at 44.1 kHz -- and `main` decoded the startup file and the
  whole built-in kit before it ever opened a device. Every kit sound was
  resampled to a rate the hardware was not running at, `set_sample_rate(48000)`
  then did nothing but print `sample rate already fixed`, and the input unit
  was opened at 44.1 against a 48 kHz microphone: AUHAL's silent zeroes, which
  is exactly the failure this section exists to prevent, arrived at from the
  other direction. Two halves to the fix and both are needed. `sample_rate()`
  answers with the set value *or* the fallback without initialising the cell,
  so a stray early read can no longer poison the process; and audio setup moved
  above the mp3 and kit loads, because a read that no longer freezes the rate
  still converts the samples to the wrong one. **Nothing in `main` above
  `get_input_output_channels` may read the rate** -- `to_device_stereo` is the
  reader to watch for, since everything that decodes a file goes through it. A
  late `set_sample_rate` that finds the fallback was already read now prints a
  `WARNING:` naming both numbers, because the old message only fired when the
  cell had been *set* twice, which was never the case that bit. Latent since
  the built-in kit landed.
- **Everything sized in frames is now a fn, not a const**: `max_input_backlog()`,
  `max_visual_backlog()` (`constants.rs`) and `max_loop_frames()`
  (`get_loop_buffer_size.rs`). They are documented in seconds -- a quarter
  second, one second, ten minutes -- and a const would quietly stop meaning that
  at 48 kHz.
- **`buffer_compensation` is still in frames, so its duration moves with the
  rate.** 4330 frames is ~98 ms at 44.1 kHz and ~90 ms at 48 kHz. It was tuned
  by ear at 44.1, so expect to retune it on a 48 kHz device. The units are
  deliberately unchanged: making it milliseconds would be redefining a key that
  restored sessions already carry, which is the `loopFeedback` trap.
- **The frontend never sees frames.** The sample stream is stamped in beats, so
  the whole draw path is rate-independent. Three references had leaked in and
  are fixed: `ANALYSIS_NYQUIST` (a hard 22050 put the top 2 kHz of the flux band
  out of reach at 48 kHz) is now `analysisNyquist()` over a module-level rate
  fetched once via the `get_sample_rate` command, and the fft dropdown's
  millisecond label divides by that rate. `mockGetArray`'s
  `beatsPerSample = 91 / 60 / 44100` is left alone -- it is fake data for
  `yarn start`, with no Rust behind it.
- Input stream is **interleaved**, output is **non-interleaved**.
  `coreaudio-rs` returns `NonInterleavedInputOnlySupportsMono` for multi-channel
  non-interleaved input, but has no such limit interleaved. That flip is the only
  reason multi-channel input works. `types.rs` has a separate `InputArgs` alias.
- Channel count is discovered from the device via
  `kAudioDevicePropertyStreamConfiguration`; if the device rejects that count it
  falls back to mono and logs it.
- **`make_buffers` hands out the same `Arc` as producer and consumer.** Despite
  the names there is one queue per channel, not two ends of a ring. If the render
  callback ever stops draining while the input callback keeps pushing, it grows
  unbounded (~172 KB/s/channel) *and* replays the backlog as stale audio.
  `MAX_INPUT_BACKLOG` (11,025 = 0.25 s) caps it. The pause path drains and
  discards rather than returning early.

### First-launch setup

`src/SetupWizard.tsx`: welcome, devices, microphone, headphones or speakers,
latency, done. A front for controls that already exist in the Setup tab --
order and explanation, never a second place anything is stored.

- **Shown on a fresh install only** (no saved session), or when setup is part
  way through; *Run setup again* is at the top of the Setup tab. An install that
  already has a session was set up by hand and is not interrupted.
- **Latency comes before the room question, and that order is load-bearing.**
  The bleed measurement is inferred through the `buffer_compensation` delay --
  it peeks `BusDelay`, whose lead *is* that number -- so running it before the
  compensation has been measured measures the wrong path, and the check refuses
  and asks for the very thing the next step was about to do. Reported from a
  real run of the wizard.
- **The step is stored by name, not by index.** It used to be an index into
  `STEPS`, which the reorder above silently redefined: a saved `4` meant
  *latency* and now means *room*. That is the `loopFeedback` trap in list form,
  so the key was **renamed** (`punching-bag.setup-at`) rather than
  reinterpreted, and an index left by an older build simply starts setup over.
  `shouldOpenSetup` still reads the old key for whether setup is part way
  through, and `finish` clears both.
- **Its progress survives a restart, on purpose.** A device change needs a
  relaunch, so the current step is written to `punching-bag.setup-step` on
  *every* move -- not only on the wizard's own "Restart and continue", because
  the device picker's Restart button relaunches too. Finishing or skipping
  removes it and sets `punching-bag.setup-done`. Install state, so localStorage
  and not config.
- **The microphone step checks that sound arrives, not that permission was
  granted.** The device is opened before any window exists, so macOS has
  already asked by the time setup shows; and the failure worth catching is an
  input of exact zeroes, which a missing grant and a sample-rate mismatch both
  produce. `get_input_levels` returns each input's peak since the last call.
  The callback accumulates peaks in a local per frame and publishes them to
  `InputLevelState`'s atomics once per callback, at the top, before any early
  return -- so the audio thread never takes a lock for a meter. The paused path
  measures what it drains, so the check works paused.
- **Speakers switches `bleedCancelOn` on only when a measurement passes**
  (`BleedMeter`'s `onPassed`, fired on the running -> done transition).
  Headphones switches it off.
- **The latency step warns when paused**, since the calibration sits after the
  pause check and would otherwise silently do nothing.

### Device selection, and the third store

The input and output devices are chosen in the panel (signal tab → *device*) and
applied **at the next launch**, not live. `restart_app` is the button; ⌘⇧R is
the same thing from the menu.

- **Not hot-swappable, on purpose.** `set_render_callback` at `main.rs:188` is a
  `move` closure that *owns* `input_frame`, `loop_visual`, `analyzer`,
  `bus_delay`, `drum_last_beats`, `tap_gains` and the consumer queues -- all of
  them sized from `input_channels`. Swapping a device means resizing every one
  of them from outside the callback, which means a lock the audio thread can
  wait on. That is precisely the hazard `DrainSizes` and the pre-sized swap
  buffers exist to remove. A two-second relaunch is the cheaper trade.
- **There is now a third store, and it is not the config.** `prefs.rs` writes
  `audio-prefs.json` in the app config dir. The config describes the music and
  the picture; this file describes the hardware in front of it. Two reasons it
  cannot be a config key: the device is opened before any window exists, so
  localStorage is unreachable at that point; and presets travel between machines,
  where a device UID or someone else's latency figure is noise. The panel still
  owns the editing -- the frontend writes through `set_audio_prefs` on every
  change, so the file mirrors what the UI shows rather than being a second thing
  to keep in sync.
- **Devices are keyed by UID.** `AudioDeviceID` is a runtime handle, reassigned
  across reboots and on replug; names are not unique, since two of the same
  interface are indistinguishable. `get_device_uid` reads
  `kAudioDevicePropertyDeviceUID`, a CFString rather than a number, cribbed from
  `get_device_name` in `macos_helpers.rs`. A device with no readable UID is
  filtered out of the picker -- it cannot be persisted, so it cannot be offered.
- **A saved device must be able to do the role it was saved for.** Existing was
  the whole test, and a device that exists is not a device that can do the job:
  `outputUid` was once set to the built-in *microphone*, `device_for_uid` found
  it, `output_fell_back` stayed false, and `audio_unit_from_device_id(mic,
  false)` came back `AudioUnit(InvalidPropertyValue)` into a bare `unwrap` -- a
  panic at launch, before any window existed, with no prompt, no UI and nothing
  in any log. `get_device_channels` now answers for either direction and
  `device_for_role` requires a non-zero count for the one being asked; a device
  that cannot serve takes **the same path a missing one already takes** --
  system default, the `fell_back` flag, and a reason string the panel prints in
  red. That the two share a path is the point: "not found" and "found, but it
  is a microphone" want the same recovery and different words.
- **The picker was offering it.** `AudioDeviceInfo` carried only
  `input_channels`, so the frontend could filter the *input* list and had
  nothing to filter the output list with -- it was fed every device,
  microphones included, from the day the picker landed. `output_channels`
  closes that, and the panel additionally clears a saved UID naming a *present*
  device with no channels for its role: a microphone will never grow an output,
  so that is a permanent wrong answer -- unlike an unplugged interface, which
  is the whole reason the choice is stored by UID at all.
- **Setup reports rather than panics.** `get_input_output_channels` returns a
  message rather than a `coreaudio::Error`, because by the time anything fails,
  *which device and which role* is the whole of what is worth knowing and
  `Err(InvalidPropertyValue)` says neither. Each unit is opened through
  `open_unit`, which retries once against the system default and says so; if
  that fails too, `main` prints the device, the role, the error and the path of
  `audio-prefs.json`, and exits. There is no window to put this in and there
  never will be, so the message is the entire account of a failed launch -- the
  *Failing loudly* argument at the one point in the program where nothing can
  be shown.
- **A saved device that is gone falls back to the system default and says so.**
  `ActiveDevices` carries `input_fell_back` / `output_fell_back` and the panel
  prints it in red next to what is actually running. Silently recording from the
  built-in mic while the user believes their interface is selected is the exact
  shape of the bug that cost a day on 2026-09-06 -- an app that looks fine and
  is listening to the wrong thing.
- **The list refreshes on Core Audio's own notification**, not on a timer.
  `watch_device_changes` registers a listener on
  `kAudioHardwarePropertyDevices` and emits `devices-changed`; the picker
  re-enumerates on it, so an interface plugged in after launch appears without a
  relaunch. The listener runs on a Core Audio thread -- not the render thread --
  and only emits a Tauri event, so it cannot stall audio. The `AppHandle` handed
  to it is deliberately leaked, because Core Audio holds the pointer for as long
  as the listener is registered and it never is unregistered.
  Two cheaper paths back it up in case the registration fails: window focus
  (plugging something in usually means clicking back into the app) and
  `onMouseDown` on the dropdown itself, which fires before the popup opens.
- `get_input_output_channels` now takes `&AudioPrefs` and returns an
  `AudioSetup` struct rather than a 4-tuple, which had run out of room.

#### Per-device latency compensation

`pairCompensations: { input uid -> output uid -> frames }` in the same file.
`buffer_compensation` in the config is unchanged -- one number, in frames,
pushed to the audio thread, which must never do a map lookup.

- **Keyed by the device *pair*, not the input alone.** What the number
  compensates for is a round trip: the click leaves at frame F, reaches your
  ears at F + L_out, you play in time with what you *hear*, so you hit at
  F + L_out, and the mic hands those frames over at F + L_out + L_in. Both
  halves are in it, which is why swapping headphones for the interface's own
  output changes the answer -- and why the auto-calibration in item 3, which
  measures exactly that round trip, has somewhere correct to write its result.
- Nested rather than a joined `"in|out"` key so the file stays readable by hand,
  and **named `pairCompensations` rather than reusing `compensations`**, which
  was input-only for one build. serde drops an unknown field, so a file written
  before this reverts to the default instead of being reinterpreted with
  different semantics. Rename rather than redefine -- the config rule applies
  here too.

- **Applied once, over the restored session.** The session is the same on every
  machine; this number is not, so on mount the stored value for whatever device
  actually opened wins. A `useRef` guard rather than state, because applying it
  must not depend on having applied it.
- **Written back on change**, guarded on equality *and* on having applied first,
  so it can neither loop nor overwrite a saved measurement with the default
  before that measurement has been read.
- **Frames, not milliseconds.** Partly because that is the unit the key has
  always been in and redefining it is the `loopFeedback` trap, and partly
  because a device implies its own sample rate -- so a per-device frame count
  absorbs the 44.1/48 difference by itself, which is the retuning problem the
  sample-rate work left behind.

#### Measuring it automatically

`measure latency` in the device section plays a 20 ms swept sine, finds it in
the input with a matched filter, and offers the frame difference.
**`docs/calibration.md` is the long version** -- why a sweep rather than a
click, why correlation is immune to the speaker and the room colouring the
probe, why not the onset detector, and what each gate means.

- **A sweep, not a click.** A click's energy is flat, so most of it lands where
  a small speaker can't reproduce it. A sweep puts its energy where speakers and
  mics are efficient, and matched filtering compresses it to a peak ~133 us
  wide -- six frames -- against the several milliseconds a click comes back as.
- **Correlation doesn't care that the sound comes back transformed.** The
  speaker, the room and the mic *convolve* with the probe, and convolution does
  not move where a signal starts. Coloration costs sharpness, not accuracy.
- **First peak, then its apex** -- an early reflection can be louder than the
  direct arrival, and the direct arrival is the one that answers the question.
  The threshold crossing finds the leading edge, so climb to the top of that
  same peak or you read ~5 frames early.
- **Five probes, median.** One door closing gets outvoted rather than becoming
  the answer.
- **It refuses to answer** on low input level, a weak match, fewer than three
  probes, or probes disagreeing by more than 5 ms -- and shows all four numbers
  *with their thresholds* whether it passes or fails, because "too quiet" and
  "loud but not locking" need opposite responses from the user. The result is
  offered with an `apply` button, never applied on its own.
- **Not the onset detector**, though it is right there. Its resolution is a hop
  (5.8 ms), and `ONSET_CENTRE_BIAS` and `onsetOffset` were themselves calibrated
  by ear against the drums bus -- measuring latency with an instrument whose
  zero point is one of the unknowns is circular.
- **Audio-thread shape**: allocated in `start_calibration`, locked once per
  callback like the display buffers, capture handed over by `mem::take` rather
  than copied, correlation run in the command outside the lock. It takes the
  callback over entirely -- no drums, looper, monitor or file, since anything
  else playing would correlate against the probe -- but still drains every input
  channel, because `make_buffers` hands out the same queue to both ends.
- Checked against a simulated round trip (low-passed, a louder-than-direct
  reflection, heavy noise) at 2200/3000/4330 frames: recovered within 4-5 frames
  each time, and silence and uncorrelated noise were both refused. Temp tests,
  run and deleted.
- **Verified against the real thing, 2026-09-06.** It measured 4331-4333 frames
  where `buffer_compensation` had been hand-tuned *by ear* to 4330 -- two
  independent methods, neither able to bias the other, agreeing within 3 frames
  (0.07 ms). Moving the microphone a few feet back added ~100 frames, which is
  2.27 ms, which at ~1.125 ft/ms is ~2.5 feet. That second check is the stronger
  one: a number that tracks the microphone's position is measuring the acoustic
  path rather than producing a plausible constant. It also retroactively
  confirms the 4330 default.

### Recording the session

`recorder.rs`, a **record to a file** section at the foot of the file tab, and
three commands. A WAV on disk, streamed rather than accumulated, because a
practice session is long.

- **Nothing touches the disk on the audio thread.** The callback appends frames
  into a buffer whose capacity is fixed *before* the recording starts, and a
  writer thread swaps that buffer for the one it drained last time and writes
  outside the lock. The exchange is all either side does under it -- the same
  contract `get_samples` has with the display buffers, and the same off-thread
  shape as the stretch render. Two buffers, both allocated at `start`, swapped
  for ever after.
- **A full buffer drops the frame and counts it.** The alternatives are
  reallocating and waiting for the disk, and the audio thread may do neither.
  `droppedFrames` is reported, so a gap in a take is never silent about itself.
- **The file is opened by the command, not the callback.** A bad path, a
  read-only disk or a full one is a failed command with a message; a failure
  later is left by the writer for the next poll, and disarms the flag with it.
  The audio thread never learns about an error at all.
- **32-bit float, not 16-bit PCM.** The output bus leaves the callback as
  `audio_out * 12.0` with nothing clamping it, so 16-bit would mean choosing a
  clip point and silently ruining a take that crossed it. Costs a `fact` chunk
  and 14 bytes over the canonical 44-byte header.
- **The whole header is rewritten on every flush**, rather than the three size
  fields being patched at the end, so a file left behind by a crash is readable
  up to the last drain instead of being a header of zeroes.
- **Two switches -- the input and the output mix -- and both on gives one file**
  `inputs + 2` channels wide: the inputs in device order, then the mix's two
  sides. One dialog answers with one file, and nothing you might want apart is
  summed together. The input recorded is `input_audio`, the domain the monitor
  and the looper share, so the high pass and the bleed canceller are in it
  exactly when their audio switches are on -- and with both off it is the raw
  capture times `audioInGain`.
- **None of it is config.** What is recorded and where is transport state like
  `paused`: a preset that armed a recording over a path from another machine is
  a surprise nobody asked for. It reaches Rust as arguments to
  `start_recording`.
- **Paused is not recorded**, and neither is a latency or bleed measurement --
  the recorder sits below those early returns, so the file holds what was
  sounded rather than a silence the transport was not running through. That is
  a judgement call; the other answer is a file whose length matches the clock.

### The practice cycle

`sections: Section[]` plus `sectionsOn`, in the Rust config. A section is *how
long, and what sounds*: `{ on, beats, click, drums[] }`. They run in order and
then start again from the top. A count-off is a section, a groove is a section,
a pause is a section with nothing on.

- **It replaced `clickToggle`, which was two of them** -- sound for
  `beatsToLoop`, silence for the next. Two mechanisms both gating the click and
  the drums is the tangle this exists to avoid, so the key is retired and
  `migrateRust` turns a session that had it on into the equivalent two sections.
  Unrecognised keys are dropped, so the old key doesn't survive alongside.
- **`sectionOrder` is the cycle written out**, as 1-based section numbers in the
  same list syntax as `beatsPerRow`: `1, [2,3]x8` is a count-off and then eight
  passes of a two-section groove. Empty means the sections in the order they are
  written.
  - **A single section needs no repeat count** -- a section says "for this many
    beats, these sound" and the rhythms tile on their own cycles, so running the
    groove four times is indistinguishable from making it four times as long.
    Write `bar*16` and the repeat is visible in the text.
  - **A *group* repeat is a different thing, and that is what the order field is
    for.** `2,3,2,3,...` cannot be expressed by lengthening, because the two
    sections mute different things. Generalising from the single-section case to
    "no repeats needed" was wrong.
  - **No new grammar.** `parseNumberList` already does groups, nesting, `x`
    repeats, parameters and arithmetic, so `[[1,2]x2, 3]x n` works and
    `MAX_LIST_LENGTH` caps the expanded cycle at 128 steps. Rust receives the
    expanded list -- `unwrapValues` hands it the `val` -- so the audio thread
    gained no concept at all beyond walking an order instead of the array.
  - **An index past the end wraps**, so deleting a section cannot leave the
    order pointing at nothing. The rule `rowColorFor` already follows.
  - Like `rowColorPattern`, it **cannot be typed back to empty**;
    `parseNumberList` refuses an empty list, so clearing the field leaves the
    last good order rather than reverting to "in order".
- **Everything is gated on `sectionsOn`, `display_start` included.** With the
  switch off nothing is muted, the cycle never wraps and every beat is drawn --
  what the app did before sections existed. `display_start` was the one place
  that forgot to ask, so a leftover hidden section went on shifting the whole
  picture by its length with nothing sounding differently to say why. It takes
  the flag as an argument now, rather than leaving the guard to the call site.
- **`show` is what keeps the cursor still through a count-off.** Off, no samples
  are stamped for that stretch at all, and the pane's timeline is measured from
  the start of the first shown section -- so the groove's downbeat lands at the
  top of the first row rather than a count-off's worth in. Asked of the *visual*
  beat rather than of `beat`, since the stream is stamped in input time and what
  matters is which section the audio being drawn was played in.
  - **A hidden section in the middle leaves a gap rather than closing up.** The
    timeline keeps running underneath, so after a hidden pause the cursor
    resumes where the music actually is; compressing would make the pane's beat
    numbering disagree with what you are playing.
  - **The analysis always runs, even for a hidden section**, because its
    spectrum differencing is a running state and a skipped hop would leave the
    next one measured against a window that never happened. What a hidden
    section drops is the *output*, truncated back afterwards -- which sets a
    length and never touches the allocator. The onsets go with it: the picker
    runs a few hops behind, so the ones emitted at the top of a drawn section
    describe the hidden one before it.
  - **It also removes the smear at the pane's tail.** A hidden last section --
    a pause, usually -- swallows the negative stamps of the first
    `buffer_compensation` frames after a restart, which would otherwise wrap
    round and draw at the end of the last row.
- **A section carries nothing else, and that is the line.** The moment it holds
  its own tempo or its own grid this is a DAW. Everything else stays global and
  is varied through the parameters, which is the surface that makes it
  interesting in the first place.
- **A count-off needs no rhythm or sound of its own** -- a section names which
  *drum voices* sound, by index, the way a pane's `channels` does. So counting
  off on 2 and 4 with a cowbell is an ordinary voice with its own rhythm. The
  cost is that a count-off voice and a groove voice are two entries, which is
  clearer anyway.
- **At the wrap, time genuinely restarts**: `beat = 0`, the file position, the
  analyzer. Nothing is learned from being at beat 7004, and resetting is what
  puts the drums, the file and the display cursor back on one.
- **Nothing recorded before a restart may play back** -- it was at the old
  tempo, against a different bar. Clearing the loop buffer would be a
  multi-megabyte memset on the audio thread, so `loop_written` counts frames
  since the restart and a tap reading further back than that contributes
  nothing. Same effect, O(1). The read distance is computed from the resolved
  index rather than from `back`, because the audio taps are offset by
  `buffer_compensation` and read a different distance than the visual ones.
- **The reroll cannot happen in the callback**, because parameters live in the
  frontend. The callback counts wraps into `VisualSamples::cycle`; the frontend
  already polls that stream 100 times a second and rerolls when the number
  moves. It rides on the sample stream rather than a Tauri event because an
  event cannot be emitted from the render callback -- it allocates and locks.
  - **So the new tempo lands a few milliseconds into the cycle.** The count-off's
    *first* click sounds at the restart either way, and every interval after it
    is at the new tempo -- and an interval is what carries a tempo. If it ever
    reads as wrong, emitting one section early is the fix.
  - The same latency means the first hit of a cycle can't use its offset
    look-ahead: there is no time before beat 0 to fire it in, so that one lands
    `offset_beats` late.
- **`section_bounds` writes into a reused vector** and returns the cycle length,
  once per callback next to the pan gains. It walks the *order*, so a section
  appearing eight times costs eight entries and no allocation after the first.
  A step with no usable length is
  *skipped* rather than clamped -- it would otherwise be a boundary the beat can
  never cross, and the cycle would stop advancing with nothing saying why.
- `beats` is expression-backed and in `resolveRustConfig`'s walk, the
  prerequisite any nested field needs before it can hold an expression.
- **For ~`buffer_compensation` after each restart the visual stamp is negative.**
  `getCanvasPositions` wraps it Euclidean, so those samples draw at the end of
  the last row -- honest, since they were captured before the restart, but it
  reads as a smear at the pane's tail. Ending the cycle with a section that has
  `show` off swallows them.

### Looper

One buffer **per input channel**, sharing a position, advancing once per frame.
Sized in frames (`get_loop_buffer_size`, no `*2`). It was previously a single
interleaved-stereo buffer recording a mono sum, which made every input show up on
every channel. Loop length and compensation timing are unchanged by that
rewrite — verified arithmetically.

It is a **multi-tap delay**, not a feedback loop. The buffer is a plain history
— `buf[p] = live`, nothing mixed back in — and the echoes come from reading it at
`loop_echoes` taps, each one `beats_to_loop` further back. Recording never stops,
so overlapping phrases just work.

- `loop_echoes` is how many times a phrase comes back; `loop_echo_gain` is the
  gain per echo, compounding, so echo *k* plays at `loop_echo_gain^(k-1)`. At 1
  every echo is full volume and the run simply stops. **3 echoes at gain 1 gives
  repeats at +4, +8, +12 beats and then silence** — verified by simulating the
  index arithmetic.
- **A gain of 0 silences every echo after the first**, which presents as the echo
  count doing nothing. That's arithmetic, not a bug — but it's why the key is
  called a gain rather than a feedback amount, and why it was renamed out of the
  way of stale sessions (see the config rules above).
- `loop_echoes = 1, loop_echo_gain = 1` reproduces the original looper exactly:
  one repeat a loop later, then gone. Those are the defaults.
- **The buffer is `spacing * echoes` frames**, since the oldest tap reads a whole
  run back. Memory grows with echoes × beatsToLoop × channels — hence
  `MAX_LOOP_ECHOES = 16` (~30MB across four channels at 4 beats, 91bpm).
  `get_loop_spacing` is one echo's worth; `get_loop_buffer_size` is the product.
- Tap offsets are taken `% loop_len` so that the callback or two between a config
  change and the buffer resize aliases briefly instead of indexing past the end.
- Tap gains are built once per callback into a reused `tap_gains` vec, next to
  `drum_last_beats.resize` — not powered per frame and per channel.
- Nothing is clamped: with finite taps the worst case is `echoes × amplitude`,
  which is loud but bounded and can't run away. Manage input gain.
- Two models were tried and rejected before this one. Gating the write on a pass
  counter turns the looper on and off. Recursive feedback (`buf[p] = buf[p]*f +
  live`) gives infinite decaying repeats that never quite stop, and can run away.
  Neither is "a fixed number of full-volume echoes, then gone".

#### Recording in cycles

`loopRecordCycleOn` plus `loopRecordCycle`, in the Rust config, and
`record_cycle_bounds` / `recording_at` in `util.rs`. Record for so many beats,
then don't, repeating -- so a phrase comes back while you play over it instead
of being recorded over. It is also the alternating record/playback named under
*Out of the looper* as the real fix for feedback on speakers: it breaks the
microphone -> speaker -> microphone path by construction rather than
suppressing it, and gives up continuous recording to do it.

- **It gates the *write*, never the read.** The buffer is a plain history and
  the echoes are taps on it; stopping the write is the only thing that means
  "keep what I played". Gating the read would mute the echoes, which is the
  `looping_on` switch and not this.
- **A gap is written as silence, not skipped.** A position comes round again
  every `loop_len` frames, so leaving it means the taps replay whatever was
  there a whole buffer ago -- a phrase that never stops coming back, which is
  the recursive-feedback looper this one was deliberately not built as. Zeroing
  costs the same store and is exactly what the looper-off branch already does.
- **`loop_written` needs nothing.** Every position is still written every frame,
  so "this far back is post-restart" still holds, and a beat restart still voids
  everything before it whatever phase the cycle was in.
- **Asked of the *visual* beat, not `beat`.** What is about to be written is
  what was played `buffer_compensation` frames ago, so gating on the output
  clock would record a window ~98 ms off from the beats the field names -- most
  of a 16th. It also means the negative visual beats just after a restart land
  in the cycle's tail, which is honest: that audio *was* played there.
- **One field, and it is a list, because `parseNumberList` already is one.**
  A bare `4` and `[32,16]x2` are the same mechanism, so a bare number is a
  one-element list rather than a second key. Expression-backed by the documented
  two-step -- in `resolveRustConfig`'s walk first, then given the syntax.
- **The list alternates and starts *silent*.** `32,16,16,16` is 32 beats off,
  16 recording, 16 off, 16 recording -- the owner's own reading, and the useful
  one: the first thing a record cycle does is leave room for the phrase you are
  about to play to come back in. An **odd** number of usable lengths is walked
  twice, so it returns in the opposite phase; without that a bare `4` would be
  silence for ever and the switch would look broken.
- **Nothing usable means record.** An empty or nonsense list must not quietly
  stop the looper taking anything in -- the failure you can hear is the safer
  one. Like `sectionOrder`, the field cannot be typed back to empty.
- **Whether this belongs on `Section` is still open**, and is deliberately left
  that way. A section is already "for this many beats, these sound" and already
  takes a list, and two independent cycle mechanisms both gating the looper is
  the tangle `clickToggle` was retired to avoid. But a section wrap also
  restarts the beat, rerolls the parameters and voids the loop buffer, and a
  record cycle that has to run *across* those cannot be a section. Standalone
  keys for now, so the decision is still available.

#### Stopping the loop running away

`loopFeedbackGuardOn`, off by default, and `loop_guard.rs`. Only matters on
speakers, and only once the bleed is already cancelled.

- **What is left after cancellation is one narrow band.** With the bleed out of
  the loop it decays almost everywhere -- a clap is gone in about five passes --
  but wherever the residual coupling is still at unity, that band grows while
  the rest dies. An ordinary howl with a two-minute time constant, and the
  reason it is slow is that the excess is tiny: twenty decibels over forty
  passes is a quarter of a decibel a pass.
- **The rule is "no band may gain energy", not "find the howl".** A PA hunts the
  ringing frequency with a peak detector and has to tell a howl from a sustained
  note. This app does not need to: the loop is its own signal, so it can watch
  each band and require that it not grow. No heuristics, and nothing to chase.
- **The cut goes to the peak band, not to every band that sees the growth**, and
  that is the trap. A ringing tone is far louder than anything else in the loop,
  so it appears through the skirts of *all* twenty-four analysis filters and
  they all report growth together -- measured, every band came down by the same
  2.9 dB, which is a broadband duck rather than a notch, and left the ring no
  quieter relative to the music than before. One band is deepened per interval:
  the loudest of those that have been growing. Everything else releases.
- **Two floors, both found by test.** A band has to hold within 30 dB of the
  loudest band, *and* the loop as a whole has to be audible. Without the first
  it cut 60 Hz against a 1 kHz ring, because a band holding nothing but
  arithmetic noise still has a ratio between one interval and the next and that
  ratio is arbitrary. Without the second it went on comparing bands of silence
  after the loop had finished.
- **A band at 0 dB is an exact pass-through.** The correction is a peaking
  biquad, whose numerator and denominator are identical at unity gain, so the
  twenty-four filters in series cost the loop nothing at all while nothing is
  wrong. Verified to 0.0 deviation.
- **Measured before the correction, corrected after**, which is what lets it
  settle rather than oscillate. The buffer records what the microphone hears,
  which is the *corrected* output coming back through the air, so a working cut
  shows up here as the growth stopping. Measuring after the cut would hide the
  thing the cut was made for, and the band would be released and re-cut for ever.
- **It fights a part you are deliberately building up.** Inherent -- a crescendo
  and a runaway look identical from inside a band -- and accepted on the owner's
  grounds that building a part up through a laptop microphone and speaker is too
  much to ask for anyway. Three consecutive growing intervals are required, which
  is what keeps an ordinary phrase from tripping it.
- Simulated: a loop that grows 82x in a minute holds at 0.3x, one that overflows
  to infinity holds at 0.5x, a steady loop is cut by 0.00 dB and silence by
  nothing at all.

If the echo count appears to do nothing, check `loop_echo_gain` before suspecting
the taps — the tap arithmetic is simulation-checked, the gain is the part that
can silently zero the run.

## Display pipeline

### Views

The canvas area is divided into panes, one `<canvas>` each, on a CSS grid of
`viewCols` x `viewRows`. The point is to watch one performance against two
rulings at once -- `0.25x16` on the left, `0.3333x12` on the right -- so rows,
margins, grids, visual gain, split, bar-colour mode and refresh mode are all
per-pane, held in `views: ViewConfig[]`.

- **A pane says where it sits**, in `col` / `row` / `colSpan` / `rowSpan`, and
  the invariant is **no two panes overlap and every pane fits inside the grid**
  -- enforced in one place, `fitViews` in `src/paneLayout.ts`, which every path
  that can move a pane goes through. `views.length === viewCols * viewRows` is
  **retired**: the arrangement is now how many *cells* there are, a ceiling
  rather than a count, so a cell may be empty and a pane may span several.
  **`docs/pane-layout.md` is the long version** -- every operation, the
  migration, and why a deleted pane leaves a hole instead of a neighbour
  growing into it.
- **A view's arrays must never be shared between panes.** `copyView` deep-copies
  for exactly this reason -- two panes pointing at one `grids` array means
  editing either edits both.
- **A pane can carry a name**, drawn small in its own top-left corner. Empty is
  the default and draws nothing, which is how every pane behaved before this
  existed. It is painted on the *visible* canvas after the layer blit and after
  the grids, never into the layer -- the sweep erases the layer a column at a
  time, so a name put there is eaten within a pass, and anything composited onto
  it repeatedly climbs to full opacity. The same two reasons the grids moved.
  **Sized in CSS pixels and multiplied by the pane's measured ratio**, like
  `gridWidth` and unlike the waveform stroke: text in surface pixels comes out
  half-height on a Retina pane and full height on an external monitor for the
  same setting. Its colour is black or white by the luma of
  `waveformBackground` rather than a config key of its own -- a label has one
  job -- and the corner it sits in is over the lead-in margin, which is the
  dimmed, duplicated part of the picture and so the least worth covering.
  Being a view key it travels in presets, so a shared preset carries someone
  else's names; that is the same trade every other per-pane setting makes.
- **Sessions from before views** carried these keys at the top level of the js
  config. `migrateViews` folds them into `views[0]` *before* `pickKnownKeys`
  runs, since that drops keys it doesn't recognise -- without it an upgrade
  would silently reset someone's rows and grids.
- **`viewsSequential` chains the panes instead of overlaying them.** Off, every
  pane covers the same beats against its own ruling -- the reason panes exist.
  On, the panes divide one long timeline: pane *k* covers the beats after every
  earlier pane's, so the signal runs through pane 1's rows, then pane 2's.
  `Layout` carries `cycleBeats` (what the display wraps on) and `chainStart`
  (where this pane sits in it); simultaneous is `cycleBeats = beatsPerWindow,
  chainStart = 0`, which is the pre-chain arithmetic exactly. Everything else
  followed from those two fields: `getCanvasPositions` subtracts `chainStart`
  and a beat belonging to another pane yields no positions, so an inactive pane
  simply stops being drawn over and holds its last pass. Margins bleed across
  the pane boundary and grids tile the whole timeline, both because the timeline
  is what repeats. `chainStart` is derived from the panes' own lengths, never a
  setting.
- **A beat exactly on a row boundary draws twice** -- dim at the end of the row
  above, solid at the start of the row below. Long-standing (the loop bound is
  inclusive at the right edge); chaining extends it to the pane boundary.
- **Each pane's backing store is measured from its own box**, in a
  `useLayoutEffect` holding one `ResizeObserver` over every canvas, times
  `devicePixelRatio`. It used to be `appWindow.innerSize()` -- the *window*, in
  **physical** pixels -- less a hard-coded 500x250, divided by the arrangement:
  numbers that stopped describing the layout as soon as the panel could be
  hidden or a gutter put between the panes, and that were in a different unit
  than the box besides. `canvasWidth`/`canvasHeight` are gone from the config
  entirely, and with them the window-resize listener that fed them.
  - **Nothing ever *moved* under the old scheme.** The draw code places
    everything as a fraction of the surface, so a beat sat on its grid line
    whatever the scale factor was. What the mismatch cost was resolution, and
    anisotropically: at the sizes in use the surface was ~1.4x the screen across
    and ~0.87x down, so the picture was oversampled horizontally and *upscaled*,
    i.e. blurred, vertically. The parts counted in pixels rather than fractions
    -- the 1px erase column, the grid hairlines, the onset ticks -- came out at
    different apparent weights across and down for the same reason.
  - **A pixel ratio change fires no `ResizeObserver`**, since the CSS box is
    unchanged, so a `matchMedia("(resolution: Ndppx)")` listener re-measures on
    it. The query can only ask about one ratio, so it is rebuilt around the new
    one each time it fires.
  - **The measurement is state, so it must not set state that has not changed**
    -- an unconditional `setPaneSizes` loops, and writing the `width` attribute
    blanks a canvas even when the number is the same.
- **Every pane carries `minWidth: 0, minHeight: 0`, and must.** A grid item's
  `min-width`/`min-height` are `auto`, and for a *replaced* element that floor
  is its own aspect ratio -- a `1fr` row will not shrink below the cell's width
  divided by the backing store's aspect. Hiding the 600px panel widened the cell
  enough for that floor to outgrow the window, and the bottom of the last row
  went under the edge of the screen. Zero lets the tracks size from the space
  there actually is -- and it is now **load-bearing in a second way**: with the
  backing store measured from the box, an aspect-ratio floor would let a bigger
  surface ask for a bigger box, which is a feedback loop rather than a
  one-off overflow.

- **A pane is cleared when its geometry changes**, not only when the background
  does -- `layoutKey` carries the backing store size, `pixelsPerBeat`,
  `cycleBeats`, `chainStart`, the margins and `beatsPerRow`. The sweep only ever
  erases columns it visits, so at a new zoom the old picture's bars stand in
  whatever columns the new one happens not to reach. The per-pane draw state is
  reset alongside, since a sweep position and a map of per-column peaks only
  mean something at one zoom -- **in place** (`Object.assign`), because the
  `ViewCtx`s the draw loop is holding reference those objects from the render
  before the effect ran, and replacing the array would leave the sweep on the
  old state.
- **`showFrameTime` overlays what the draw loop costs**, to answer whether a
  repaint-everything model is affordable before restructuring the draw path for
  it (see *Discussed but not built*). Off by default.
  - **It writes `textContent` from inside the loop, never through React.** A
    readout that caused a render sixty times a second would be measuring
    itself. The measurement is taken unconditionally -- two `performance.now()`
    calls -- and the write is skipped when the node isn't mounted.
  - **`draw` and `frame` answer different questions.** `draw` is the JS side of
    a frame; `frame` is the gap between callbacks, which is what actually says
    whether the loop is keeping up. Canvas work can be queued and rasterised
    after the JS returns, so a small `draw` next to a long `frame` means the
    cost is real but not where the timer is.
  - Accumulated over 250 ms and flushed, because a number changing every frame
    is unreadable -- and the **max** is the half that matters, since a repaint
    model would show up as occasional long frames rather than a raised average.
  - **`ops` and `us/op` are what make the timing actionable.** Every canvas
    primitive in the hot paths increments one counter, so the readout separates
    "there is too much to draw" from "each thing is drawn too expensively".
    Only the second is fixable without changing the picture, and the two call
    for opposite work.
  - **Measured 0.22 us/op, so the sweep was op-count bound, not state bound.**
    ~7 ms at that rate is ~32,000 primitives a frame -- which is what the
    per-column flush below was for.
  - **Measured under a stress test: ~7 ms average, ~30 ms max, 55-60 fps** --
    the sweep spending ~40% of a 60 Hz budget and dropping the occasional frame
    *before* any repaint model was considered. **After the per-column flush
    below: under 1 ms average, ~2 ms max, ~275 ops.** A hundredfold fewer
    primitives, and the headroom question is now settled the other way.
  - **`us/op` stops meaning anything once `ops` is small.** At ~275 the frame's
    cost is dominated by what the counter doesn't count -- the per-sample peak
    accumulation, `getCanvasPositions`, plain loop overhead -- so the figure
    rose to 1-2 while the frame got seven times cheaper. Read it only when
    `ops` is in the thousands.
  - A literal full repaint is still out: rows x pane width columns per channel
    per pane, of order 200k primitives, which at the 0.22 us/op measured when
    the counter was meaningful is ~50 ms a frame. Affordable **on demand**,
    never per frame. See *Discussed but not built*.
- **`drawSweep` flushes once per pixel column, not once per sample.** It used
  to compare the sweep position as a float, which changes on every sample, so a
  column was erased and redrawn once per sample that landed in it -- several
  times over at any zoom, and more the wider the pane. The `channelPeaks`
  accumulator was already there for exactly this; only the boundary was wrong,
  and the spectrogram had always flushed this way (`Math.floor`).
  - **A column is painted at `pendingBeat`**, the last beat that landed in it,
    when the sweep leaves -- not at the beat that triggered the flush, which
    belongs to the *next* column and would draw every peak one column late.
    `canvasPos` starts at -1 and `pendingBeat` at NaN so the first column of a
    fresh pane isn't painted from an empty accumulator.
  - **The picture gets more accurate, not just cheaper.** One stroke at the
    column's true maximum replaces several overlapping antialiased strokes at
    fractional x whose blend only approximated it.
  - It costs up to one column of display latency -- the tens of microseconds of
    audio in a pixel.
  - **It also exposed the eraser, which had never fully erased.** `eraseColumn`
    stroked a 1px line at a fractional x, which covers two columns at partial
    opacity; while the sweep flushed once per *sample*, several of those piled
    up per column and between them cleared it. One flush per column left a
    single partial stroke, and the previous pass showed through -- worse the
    further out you zoom, since that is where the pile-up had been deepest. The
    eraser and the channel trace now share `columnLeft(x, span)` and both draw
    filled rects on whole columns, so what is drawn is exactly what gets cleared
    next time round.
  - **Whole columns across, fractional down.** The horizontal edges have to land
    on the pixel grid for the eraser to cover them; the vertical extent is the
    *signal*, and rounding it would drop a quiet passage to nothing rather than
    drawing it faintly.
    - **So the eraser has to floor and ceil, not round.** A full-amplitude bar
      antialiases into the pixel row at each end of its box, and the eraser
      rounded that box instead of taking every pixel it touches -- leaving a
      fringe at the top or bottom edge of a row that only a loud sound reached
      far enough to expose. It bit 179 of 342 rows across a sweep of realistic
      pane heights and row counts. `rowBox` is now the single definition of a
      row's extent, read by the eraser, the waveform, the onset ticks and the
      spectrogram column alike; the two had been computed separately and drifted.
      Grid lines are the exception and stay rounded to the *full* row height --
      they are painted onto the visible canvas rather than the layer, so the
      eraser never sees them.
  - **`span` is how many columns the sweep just crossed, computed per copy on
    screen**, and normally 1. It is greater where the zoom puts consecutive
    samples more than a pixel apart, and those skipped columns have to be
    erased too -- the same ghosting at the other end of the zoom range.
    - **It cannot be taken once from the loop's own column index.** A row's `x`
      is the loop position minus a *fractional* offset (`rowStart` and
      `marginLeft` times `pixelsPerBeat`), so `floor(x)` and `floor(loopPixels)`
      cross pixel boundaries at different moments. One span for every copy left
      a column unvisited at some zooms -- and an unvisited column is never
      erased, so a bar from an earlier picture stood there indefinitely. The
      span comes from `lastFlushPixels` instead: the columns crossed are
      `(floor(x - advance), floor(x)]`, evaluated at each copy's own `x`, which
      tiles the column space exactly.
    - A non-finite advance is the first flush and a negative one is the loop
      wrapping; both mean "just this column". The pane's width bounds the rest.
- **Each pane draws through an offscreen layer.** `layers` holds one detached
  canvas per pane carrying everything painted *incrementally* -- the sweep's
  waveform, the flux, the onsets, the spectrogram's columns. Every frame the
  visible canvas is rebuilt: one `drawImage` of the layer, then the grids over
  it.
  - **The grids are the whole reason.** They used to be painted straight onto
    the pane every frame, compositing over their own previous pass, which drove
    any `alpha` below 1 to opaque within about a second -- so a grid's alpha was
    honest only just after the sweep erased it. Onto a surface rebuilt every
    frame they land exactly once, at the alpha asked for.
  - **It also settles where a grid line sits.** Sweep mode had them *under* the
    waveform in the column the sweep was in and *over* it everywhere else;
    whole-cycle mode had them under; the spectrogram drew them per column,
    clipped, specifically to dodge the compositing problem. All three now paint
    them on top, once, and the spectrogram's clip dance is gone.
  - **The layer is sized on demand** in `layerFor`, and setting either dimension
    blanks it -- which is what a resize wants. It is filled with the background
    on creation, so the `drawImage` is opaque and the pane needs no clear of its
    own.
  - Cleared alongside the visible canvases whenever the background or
    `layoutKey` changes: the layer is where the stale picture actually lives.
- **One `requestAnimationFrame` loop, in `App`.** It draws every pane and then
  drains the sample batch **once**, after all of them have read it. `Canvas.tsx`
  used to own the loop and clear the buffer itself; with more than one pane that
  races, and whichever drew first would eat the samples. The loop reads the
  current draw closure through a ref rather than depending on it -- the old
  `[draw]` dependency rebuilt the loop on every render.
- **Draw state is per-pane** (`ViewDrawState`): sweep position, cycle columns,
  and channel peaks. Panes disagree about where a pixel column ends, because
  `pixelsPerBeat` is derived from each pane's own cell width.
- Only `channelStyles` and the channel selection stay global, so a channel keeps
  its colour in every pane -- unless the pane sets row colours, below.

### Pane placement

`col` / `row` / `colSpan` / `rowSpan` on `ViewConfig`, `src/paneLayout.ts` for
every operation, `src/PaneMap.tsx` for the buttons. **`docs/pane-layout.md` is
the long version**, including the two designs that were rejected.

- **0-based, and the spans are counts.** CSS grid's 1-based lines are converted
  in exactly two places, the canvas style and the map.
- **`fitViews` is the only enforcement point**, and nothing else may write the
  four keys. It walks the panes in the order they *read* -- top-left cell, row
  first -- clamping each onto the grid, capping what it may take so a pane
  behind it still has somewhere to go, relocating it if it collides, and
  dropping it only when the grid has no free cell at all. Dropping is what
  truncating to `cols * rows` already did; 2x2 to 1x1 still loses three panes.
- **Nothing in the draw path changed, and that was the bet.** Each pane's
  backing store is measured from its own box and everything is placed as a
  fraction of that surface, so a pane spanning two cells is just a pane with a
  bigger box. `minWidth: 0, minHeight: 0` is load-bearing a *third* time for
  the same reason: a spanning pane's automatic minimum would be twice the
  floor, and a track sized from it would push its neighbours off screen.
- **A deleted pane leaves a hole.** A flat grid has no split tree to say which
  neighbour should absorb the space, and a heuristic that picks the wrong one
  has silently resized a pane you were reading. *Wider* and *Taller* close it
  in one click, and refuse rather than collide.
- **Add takes the first empty cell, or refuses.** Growing the grid from a
  button labelled "add a pane" would resize every other pane as a side effect;
  the arrangement dropdown is one line above it.
- **Swap exchanges whole rectangles**, position and span together -- swapping
  positions alone can overlap a third pane whenever the two differ in size.
- **The chained timeline runs in `paneOrder`**, by top-left cell, not in array
  order. Array order is creation order, which stops matching the screen the
  first time a pane is swapped or added into a hole.
- **A pre-placement session is placed in reading order** by `normalizeView`'s
  fallback, all four keys together. The defaults put a pane at the top-left
  cell, so merging a placement-less saved pane over them would stack a whole
  layout in one corner -- the `loopFeedback` trap where it would be immediate
  and destructive. A pre-placement config is still padded to `cols * rows`
  panes; a config written since is not, because an empty cell is a layout.
- **The panel's selection is a position into `views`**, like the draw state,
  the layer and the canvas ref, so removing a pane shifts it --
  `selectionAfterRemove` is that arithmetic. The rest are covered by
  `layoutKey`, which changes whenever the number of panes does and repaints
  every pane.
- **Drag to resize is deliberately not built.** Buttons only: one click, a
  definite answer, and a refusal that shows as a disabled button rather than a
  drag that snaps back.

### Rows wrapped into columns

`rowColumns` is per-pane, default 1, and wraps the rows into strips side by
side -- newspaper fashion, filling a strip top to bottom before starting the
next. Sixteen rows as two columns of eight is what makes *one row per note*
readable past about sixteen rows.

- **One source of truth, not several panes.** One `beatsPerRow`, one set of
  grids, one set of margins, one channel list. Two panes kept in sync by hand
  is the thing this exists to avoid, and it is the owner's own framing.
- **`pixelsPerBeat` is a *strip's* width over the longest drawn row**, so two
  columns halves it exactly. That is the trade -- twice the rows, half the
  resolution -- and it is arithmetic rather than a compromise.
- **`rowPlacement` in `layout.ts` is the single definition of a row's
  horizontal extent**, the counterpart to `rowBox`'s vertical one, and
  `clipToStrip` in `App.tsx` is what every painter goes through: the eraser,
  the waveform, the flux, the onset ticks, the grids and the spectrogram's
  backwards-drawn columns. They have to agree exactly, for the reason the
  eraser and the waveform already share `columnLeft` -- the sweep only erases
  columns it *visits*, so a pixel painted into a neighbouring strip is one
  nothing ever comes back to clear.
- **`columnWidth` is floored to a whole pixel.** A fractional strip boundary
  leaves one pixel column shared between two strips, each erasing the other's
  edge; the few pixels lost to the rounding sit unused at the pane's right
  edge. For the same reason `drawSweep`'s span is bounded by the strip rather
  than by the pane -- and the clip clamps both ends independently rather than
  rejecting a run, so a position at a row's right edge still erases what it
  painted.
- **`Position.row` stays the pane's own row index** and `rowInColumn` is the
  drawn one. `rowColorPattern` is indexed by the first -- "every fourth row
  marks the beat" has to keep meaning that once the rows are dealt into strips.
- **The rows per strip are what is fixed**, so a column count the rows cannot
  fill collapses (4 rows in 3 columns is two strips of two, not two and an
  empty third) and an uneven split leaves the gap at the bottom of the last
  strip (5 rows in 2 columns is 3 then 2).
- **`layoutKey` carries it**, like every other piece of geometry: a different
  number of strips leaves the old picture standing in columns the new one never
  reaches, exactly as a zoom change does.
- Not rebalanced by row *length*: a swung `[.6,.4]` list splits by count, so
  two strips can hold different total beats. That matches how one margin
  already serves every row.

### Layout chrome

`waveformBackground`, `paneGap` and `paneGapColor` in `defaultJsConfig`, edited
in the *layout* Section at the top of the visual tab. What a pane sits on, and
what sits between the panes -- the frame rather than the signal.

- **Global, not per-pane.** A gutter belongs to no one pane, and a background
  differing pane by pane would read as a difference in what is being *drawn*
  rather than in what it is drawn on. The per-pane palette is `rowColors`, which
  describes the signal; these describe the surface. `WAVEFORM_BACKGROUND` was a
  module constant and is now `const background = get("waveformBackground")`,
  read once per render next to `viewCols` -- the three draw sites (`eraseColumn`,
  the spectrogram column, `paintWholeCycle`) close over it.
- **Changing the background repaints every canvas from an effect**, because the
  sweep *never clears*: it erases one column at a time just ahead of where it
  draws, so a new colour would otherwise arrive a column per frame and leave the
  pane in two colours for a whole cycle -- and dragging the picker makes that a
  stack of bands. The repaint costs the waveform already on screen, which is
  what a resize already does.
- **The gutter is the grid container showing through**, so `paneGapColor` is
  that element's `backgroundColor` and not anything a canvas paints. It is
  invisible at a 1x1 arrangement or a gap of 0, and the panel says so rather
  than leaving a control that appears to do nothing.
- **The gap costs the panes their width, exactly.** The gutter comes out of the
  grid's tracks, and each pane's backing store is measured from the track it
  lands in, so a wider gap gives every pane a genuinely narrower surface rather
  than the same surface squeezed. Nothing has to know the gap is there.
- **`gridWidth` is in CSS pixels, not surface pixels**, and `drawGrids`
  multiplies it by the pane's measured ratio. The hard-coded `lineWidth = 2`
  was in surface pixels, so its weight moved with the surface-to-screen scale --
  hiding the panel used to make grid lines 65% heavier, and a Retina pane drew
  them at half the weight an external monitor did. A CSS width is the same line
  everywhere. The default of 1 is exactly what the old constant came to on a 2x
  display, so nothing changes until the slider is moved.
  - **Grid lines are filled rects on whole pixels, not strokes.** A stroke at a
    fractional `x` -- which is every one of them -- spreads its width over one
    more column than it asked for, at partial coverage. That would only be soft
    edges, except that sweep mode repaints the grids *every frame*, so alpha
    compositing drives every column the stroke touches to full opacity within
    about a second. The width on screen was therefore how many columns the
    stroke overlapped: 1 device pixel and 2 came out as 2 columns and 3, which
    is why the control looked like it did nothing. `fillRect` on rounded
    coordinates with a whole-pixel width draws exactly the columns asked for.
  - **A grid's `alpha` used to be nearly inert in sweep mode**, honest only for
    the fraction of a second after the sweep passed a line and then saturating.
    The offscreen layer fixed it: the grids land once, on a surface rebuilt
    every frame. See *Each pane draws through an offscreen layer*.
  - **0.5 is the floor because that is one device pixel on a 2x display** --
    the thinnest line the screen can draw, which is the end of the range worth
    having. Below it a line is a fraction of a pixel and antialiases to a
    smudge; a fainter grid is what each grid's own `alpha` is for.
  - **The panel resolves the width against `paneSizes[0].scale`**, the ratio the
    panes were actually measured at, rather than reading
    `window.devicePixelRatio` again -- the readout should name the number being
    drawn with, not a second opinion about it.
  - The waveform stroke, the erase column and the onset ticks are **still in
    surface pixels** and so still display-dependent. They are a coupled set --
    the eraser must be at least as wide as what it erases -- and giving them CSS
    widths would double their weight on a Retina display, which is a look to
    choose deliberately rather than to inherit from this change.
- **`ColorInput` is called by name, not dispatched on type.** `Input` picks its
  widget from the value's type, and `filePath` is a string too -- "every string
  is a colour" would be wrong the moment anything else took one. Same treatment
  as `Slider` and `RowColorList`.

### Row colours

`rowColors` is a per-pane list of colours and `rowColorPattern` says which row
takes which, 1-based, in the same `parseNumberList` syntax as `beatsPerRow`.
`rowColorFor` in `config.ts` resolves them, next to `gridAlpha` and `drumGains`.

- **Both patterns are expression-backed**, so `1, 2x(n-1)` puts a beat marker
  every `n` rows and follows a parameter change. They are in `resolveView`'s
  walk, which is the prerequisite (see *Parameters and expressions*); the widened
  `NumberListExpr | number[]` and `normalizeView`'s `wrapList` are how a saved
  palette survives the shape change. `rowColorFor` reads both through
  `exprList`, so a bare array that reaches it anyway still colours.
- **The pattern is cycled by row index, not stretched over the rows.** Like drum
  `gains`, a pattern that doesn't divide the row count drifts rather than
  resetting. That's the point: `0.25x16` rows with `"1,2x3"` puts colour 1 on
  rows 0, 4, 8, 12 -- exactly the 16ths that start a beat.
- Empty `rowColors` means rows keep the channel's colour, so panes behave
  exactly as they did before this existed. One colour (or an empty pattern)
  paints every row the same. The pattern input only appears once there are two
  colours to choose between; emptying the colour list is the off switch, since
  `parseNumberList` rejects an empty list and so can't clear the pattern.
- An index past the end of the colour list **wraps**, so deleting a colour can't
  leave the pattern reading `undefined`.
- **Row colour overrides the channel colour**, so with several channels visible
  in one pane they all draw in the row's colour. `barColorMode` still wins over
  both -- it encodes amplitude as brightness, so a hue would have nothing to
  say.
- **A split row can read the palette through two patterns.**
  `rowColorPatternDown` is the lower half's, and empty -- the default -- means
  it reads `rowColorPattern` like the upper half, which is how panes behaved
  before it existed. One palette rather than two lists: with `1,2x3` above and
  `3,4x7` below, the two channels come out of different parts of the same
  colours and both still mark the beat. `rowColorFor` takes the half, and
  `"both"` (an unsplit row) reads the upper pattern.
- Like `rowColorPattern`, it **cannot be typed back to empty** --
  `parseNumberList` rejects an empty list, which is also why an empty pattern
  field shows a red border in a pane that has colours but no pattern yet. The
  value is right (every row takes colour 1); only the border is misleading. Setting it to the same text as the
  upper pattern is the equivalent, and turning `splitChannels` off ignores it
  entirely.

### Grid and click offsets

Both are the *musical* half of the drum pair -- a `shift` in beats, positive
moving the pattern later, subtracted (or added, on the display side) the same
way `DrumVoice.shift` is. Neither gets a millisecond partner: a grid is drawn,
not sounded, and the click is synthesised in the callback, so there is no file
attack to align.

- **`VisualGrid.shift` is expression-backed**, unlike the drums'. The drums'
  are literals because they are nested in the `drums` array and *not* in the
  re-resolution walk, so an expression there would go stale on a parameter
  change; `resolveView` already walks every grid to re-resolve its rhythm, so a
  grid's shift is re-resolved with it and `1/3` or `bar/n` are safe to type.
- **Optional, like `alpha`**, and read through `gridShift`. Left absent rather
  than defaulted by `resolveView`, so a preset saved before this keeps its shape
  and answers 0.
- **Reduced modulo the pattern length before drawing**, since the pattern tiles
  every `end` and a whole pattern of shift is a no-op -- the same property the
  drums' shift has. The tiling starts one pattern *early* (`startBeat = -end`)
  and skips negative results, or a shift would leave the first beats of the pane
  empty instead of filling them from the previous tile.
- **`clickShift` is an ordinary `RustExprKey`** -- registered in `RustExprKey`,
  `RUST_EXPR_FIELDS` and `RUST_EXPR_KEYS` like every other Rust-side expression
  -- and reaches the callback as `beat_bisect(&click_times, beat -
  config.click_shift)`.

`getCanvasPositions(layout, beat)` in `layout.ts` returns **every** place a beat
appears on screen. Each row draws its own beats plus `marginLeft` beats of lead-in
and `marginRight` of lead-out; because the loop repeats, a margin wider than the
loop shows the same beat multiple times (a 1-beat row with margins of 2 draws it
five times, filling the width). Copies outside a row's own beats are flagged
`isMargin` and drawn dimmer.

The canvas is **never cleared** in sweep mode. Erasure is a dark
`WAVEFORM_BACKGROUND` column painted by `eraseColumn` just before the channels are
drawn over it. Two draw modes:

- **Sweep** (default) — erase and redraw each column as the cursor reaches it.
- **`refreshAtCycleEnd`** — accumulate a peak per pixel column for the whole
  window, then `fillRect` + repaint everything when the beat wraps. No per-column
  erase here (the fill already cleared), so grids stay visible behind quiet parts.

### One row per note

`RowPerNote.tsx`, a button under *layout* in the views tab. The setting the
owner reaches for most, and the one nobody else would arrive at: one row per
note you are aiming at, so sixteen 16ths are sixteen rows and the target is a
straight vertical line down the pane. "Am I hitting each note" and "am I
drifting early" are then both readable at a glance.

- **It is a generator, not a mode.** Everything it writes is an ordinary
  per-view setting, so after `apply` there is nothing holding the pane in this
  shape, nothing to un-press, and nothing that can fight a later hand edit.
  Same idiom as `set tempo from file` and the calibration's `apply` -- compute
  something worth having, write it into fields that already exist. A `kind` or
  a `gridFollowsRows` flag was the alternative and is worse: it makes a second
  source of truth for the grids and the margins, and has to decide what nudging
  a margin means.
- **It writes expressions, not the numbers they come to.** Typing `bar/n`
  leaves a pane whose rows, margins and both grids all follow `n` afterwards --
  the configuration staying *live* rather than being stamped, which is the one
  thing a preset could not give even if presets were per-pane. It is also the
  app demonstrating its own parameter system on the way past.
- **Three fields, and they are the only choices in it**: the division (a
  number-list expression, so `1/4`, `bar/n` and a swing pair `.6,.4` all work),
  how many of them, and the lead.
- **Equal and opposite margins rotate the row window without widening it.**
  `pixelsPerBeat` divides by `max(row) + left + right`, so `+d/4, -d/4` leaves
  the drawn width at exactly one pulse: every instant still appears exactly
  once -- no duplication and no gap -- with the target a quarter of the way
  across and the half-way marker three quarters. That symmetry is why a quarter
  is the default, and the room before the note is for a sustain that ran over.
- **Two grids: the target, and the point exactly out of phase with it.** Green
  and red, target first in the list so it wins where they coincide. The second
  is the first shifted by half a pulse, which is the whole reason a grid's
  `shift` is expression-backed.
- **The half-way marker is the one part that does not generalise for free.**
  With an uneven division the midpoints are not a constant shift of the notes
  (`.6,.4` puts them at 0.3 and 0.8), so it is written as the gaps *between*
  the midpoints plus a shift onto the first -- the last gap closing the cycle
  rather than stopping short of it: `[.5,.5]:1` shifted by 0.3. That degenerates
  to the even case exactly, so there is one formula rather than two. What it
  costs is that the swung version is literal numbers and stops following a
  parameter change.
- **One margin serves every row, so an uneven division takes the mean pulse**
  and the rows come out different lengths. That is what a swung setting looks
  like rather than a defect -- the owner's own observation, from doing it by
  hand.
- **Applied as one patch, in one update.** Four keys written one at a time
  through `viewSetGet` would work, since each is a functional update over the
  last, but a pane shape is one configuration rather than four independent
  edits and a half-applied one draws something nobody asked for.
- **Re-opening recovers the expressions rather than the numbers.**
  `splitRepeat` takes `bar/n x 16` apart at the top-level `x` -- one at bracket
  depth zero that does not *continue* a name. A digit run doesn't make a name,
  so `0.25x16` splits, which matters because that is exactly how
  `formatNumberList` writes a repeat, while `maxx` is left alone. Without that
  distinction the form reopens showing `0.25` and `16` as one unparsed string.
- It **replaces** the pane's grids rather than adding to them, which is what
  makes the result predictable from the three fields alone.

Checked by temp test (run, then deleted): the even case writes 16 rows of 0.25
with margins that cancel; replaying `getCanvasPositions`, the target lands at
25% of the row and the antipode at 75%, and sweeping 977 beats off the grid
finds every instant drawn exactly once (in the swung case too); the grid lines
tile at the pulses and the midpoints; `bar/n` survives into all four fields;
the swung case alternates the row lengths and puts the markers at 0.3 and 0.8,
from a literal list and from a list parameter alike; `splitRepeat` handles
`bar/n x 16`, `0.25x16`, `[.6,.4] x 8`, a nested `[[.6,.4]x2, 1]x3` and refuses
`maxx`; and a non-positive pulse, a count below one, a count past
`MAX_LIST_LENGTH` and a lead outside 0..1 are all refused rather than written.

### The visual latency offset

The sample stream is stamped with `visual_beat = beat - buffer_compensation *
beats_per_sample`, i.e. in *input* time, so audio you played is drawn where you
played it. The drums and click aren't captured — they're synthesised in the
callback — so that shift would draw them ~98 ms early. `BusDelay` in `structs.rs`
holds both bus values for `buffer_compensation` frames so they meet the stamp on
their own beat. It only allocates on resize, which happens once per callback next
to `drum_last_beats.resize`. Audio is untouched by this; it is display-only.

### Channels

Channels are named by *device channel index*, and indices past the input count
are **synthetic buses**, in the order the frontend labels them:

```
[ ch 1 … ch N ]  [ drums ]  [ click ]  [ file ]
     inputs        bus N      bus N+1    bus N+2
```

The frontend's `channelLabels` order **must** match how `main.rs` fills them.
Only real inputs are pannable — the buses aren't routed.

The sample stream is flattened — `{channels, beats, values}`, one beat per frame
and `channels` values after it, read as `values[i * channels + c]`. Flattened
rather than a Vec-of-Vecs so the audio callback never allocates per frame.

**Which channels a pane draws is per-pane** (`views[i].channels`), and
`visibleChannels` is no longer a setting: it is the *union* of what the panes
ask for, and exists only to tell the callback what to pack.

- **Everything user-facing is indexed by device channel.** The pane's list, the
  colours (`channelStyles`, global, so a channel looks the same everywhere), the
  pans, `spectrogramChannel`, and the flux and onset streams all agree. Only the
  sample stream is in packed order, and `streamSlots[channel]` is the one place
  that translates. Before this there were two conventions and `drawFluxAt` was
  where they collided.
- **The union is pushed from an effect**, guarded on equality, rather than from
  each of the five places the panes can change (a per-pane edit, the
  arrangement, a preset, the restored session, a pane being dropped). It cannot
  loop: the union is a pure function of `views` and the push is a fixed point.
  This is the one pane setting that reaches the audio thread at all.
- **A channel a pane wants that isn't packed yet reads `undefined` and is
  skipped**, so the frame or two between adding a channel and the stream
  widening draws nothing rather than misreading a neighbour.
- `splitChannels` splits by position *within the pane's own list*, so two panes
  showing different pairs each split their own.
- **`channelGains` is a per-channel display trim**, sparse and 1 where unset,
  multiplied into the pane's own `visualGain` so a quiet mic and a hot line can
  share a row. Display only -- unlike the pans it never reaches the audio
  thread -- and it applies to the synthetic buses too. Waveform only: the flux
  and the spectrogram have their own gains, and the flux is a normalised dB
  measure that a level trim would say nothing about.
- **A session written before this has no per-pane lists**, so `normalizeView`
  seeds every pane from the old global `visibleChannels` — including the
  pre-views path, where `defaultViewConfig()`'s own `channels: [0]` would
  otherwise win and quietly reset what was on screen.

### Drums

Each `DrumVoice` has a path, its own rhythm, a volume, an offset in ms, and a
`shift` in beats. The two offsets are different things: `shift` is *musical*
placement (which beat the part starts on, tempo-independent) and is subtracted
from the beat before bisecting; `offset` is *mechanical* alignment for the file's
attack and is added. A shift of a whole cycle length is a no-op, since the rhythm
repeats.

#### One lane per voice

**A voice is one row -- on, name, rhythm, volume -- and everything else is
behind a chevron.** It had grown to seven controls sharing a 600px panel, four
of them `flex: 1` over whatever was left after the name and the slider, so
each got about 50px. Monospace made that acute rather than causing it: a
fixed advance costs roughly a fifth of the characters a proportional face
fits, which is the difference between reading `[0.6,0.4]` and reading `[0.`.

- **Folding a field away must not hide that it holds something.** A voice with
  a chance list and one without would otherwise read identically while
  sounding completely differently, which is the whole hazard of a disclosure.
  The chevron carries a dot when there is anything behind it and names it in
  the tooltip -- a mark as well as a colour, so it does not rest on hue. `1`
  is the unset gains text and does not count as something set.
- **Hidden, not unmounted**, exactly as `TabPanel` is and for the same reason:
  these fields hold half-typed text, an expression is invalid for most of the
  time it takes to type one, and folding a lane shut must not be a way to lose
  what you were in the middle of writing.
- **The hidden fields gained labels**, which the columns had been standing in
  for. A column header four controls away from its field was the weakest part
  of the old row even when it fitted.
- Remove stays on the lane rather than moving inside. It is the one control
  whose *absence* would be surprising, and hiding a delete does not make it
  safer, only harder to find.

`gains` is a list of per-hit multipliers on top of `volume`, using the same
`parseNumberList` "1,0.5x3" syntax as `beatsPerRow`. It is indexed by *hit count*
(`hit.rem_euclid(gains.len())`), not by position in the bar, so a list whose
length doesn't divide the rhythm's deliberately drifts in and out of phase rather
than resetting each cycle. Empty means no modulation.

`chances` is a list of per-hit *probabilities* beside it, same syntax and the
same `rem_euclid` indexing, so the two read the same entry as each other.

- **A hit that loses the roll keeps its slot.** Only the sample is dropped:
  `drum_last_beats` still advances and nothing about the part's length or `end`
  moves, which is the whole of what keeps `chances` and `gains` in phase. A
  version that skipped the slot would make the accents walk against their own
  rhythm whenever a hit was thinned.
- **The roll is taken at the trigger**, which is `offset_beats` early -- still
  exactly once per hit -- and *before* the section gate, so a muted section
  doesn't change the sequence the rolls come out in.
- **The comparison is its own clamp.** `gen::<f64>()` is half-open on [0,1), so
  1 or more always sounds, 0 or less never does, and a non-finite chance fails
  every comparison and stays silent. A typed `2` is therefore sensible rather
  than a refused config push -- the *Failing loudly* rule, answered by
  arithmetic rather than by validation.
- **Empty is the default state, so the field can be typed back to empty** --
  unlike `gains` and `rowColorPattern`, where `parseNumberList` refusing an
  empty list is harmless because there is no off state to return to. Clearing
  it removes the key, which is exactly what an untouched voice looks like.
- Expression-backed, added to `resolveRustConfig`'s walk *first* and made
  expression-backed second -- the documented ordering, and the reason `offset`
  and `shift` are still literals.
**The offset is a look-ahead, not a seek**: triggering evaluates
`beat_bisect(times, beat + offset_beats)` so the sample starts *early* and its
transient lands on the beat. Seeking into the file would chop the front off a
slow attack. `offset_beats = offset_ms / 1000 * bpm / 60`.

**A hit written on beat 0 sounds at launch.** Two separate swallows had to go,
and both were inaudible for the same reason -- Rust used to be sounding its own
defaults while the window came up, so by the time anyone's real config arrived
the parts were already mid-phrase and nobody could tell the first hit had been
eaten. Making the transport start silent is what exposed them.

- **The drums.** A voice seen for the first time (`drum_last_beats[v] ==
  isize::MIN`) records where the beat already is rather than firing, so adding a
  part half way through a phrase doesn't sound it instantly. At the *start* of
  the transport that rule is wrong: nothing has been missed, and a hit on beat 0
  is one you asked to hear. The seed is `hit - 1` when the callback began with
  `beat == 0.0`, which makes the ordinary change test fire it. `beat` only
  leaves 0 by accumulating, so that condition is also true after `reset_beat`
  and after a practice-cycle wrap, which is what you want in all three cases.
- **The click.** `last_beat` started at 0, which is exactly `beat_bisect`'s
  answer for beat 0, so the first click was compared equal and dropped. It
  starts at -1 -- the subdivision before the first. Unlike a drum voice the
  click is never added mid-phrase, so there is no case this fires spuriously.
- **The samples have to be there too.** A voice whose file is still decoding has
  no entry in the map and the callback skips it outright, so its hit on beat 0
  goes missing however the trigger is seeded. The first config push now waits on
  `load_drum_sample` for every voice before it goes -- `allSettled`, so a
  missing file delays nothing, and raced against `FIRST_PUSH_WAIT_MS` so a file
  on a volume that never answers costs a moment of silence rather than the
  whole session. That timeout is load-bearing: the silence gate is what would
  otherwise make a wedged decode permanent.

**A voice is gated on the section a hit will *sound* in, not the one its trigger
fires in.** Those are `offset_beats` apart by construction -- the offset is a
look-ahead so the transient lands on the beat -- so testing at the trigger
sounded the note at the top of a silent section and dropped the one at the top
of a sounding section, exactly the wrong two. `section_at` takes the sounding
beat and reduces it into the cycle, which is also what lets a look-ahead ask
about a beat past the wrap. A `shift` needs no correction: it moves where the
note sounds *and* when it triggers, together.

`shift` and `gains` carry `#[serde(default)]` because `presets.ts` only merges top-level
keys — a session saved before it existed has drum voices without the field. The
TS side mirrors this with optional `shift?` / `gains?` read through `drumShift()`
and `drumGains()`, the same pattern as `VisualGrid.alpha`.

Files are decoded in Rust by `load_drum_sample` and keyed by path; the callback
only does a map lookup. Built-ins are keyed by plain name (`"ride"`) so a voice
can refer to one without knowing the install path.

**The built-in kit** is kick, snare, closed hi-hat and ride, bundled in
`src-tauri/samples/` (already a Tauri resource). A kit sound is what makes a
preset's drums work on someone else's machine, where a file path would not.

- **`samples/kit.json` is the one list**, and each entry is three separate
  things: `id` (what a preset stores -- `kick`, `snare`, `hi-hat`, `ride` --
  and so **never renamed once shipped**, the `loopFeedback` rule again), `name`
  (only what is shown, free to change), and `file`. Rust reads it at startup,
  files each sample under its id, and hands the list over through `get_kit`;
  the frontend keeps it module-level in `config.ts` (`setKit` / `kitSound`),
  like the sample rate, because `drumLabel` is called where state can't reach.
  Adding a sound is a file and a line of JSON, with no code change.
- **`load_drum_sample` answers from the map when the key is already loaded.**
  So the frontend never has to know which names are built in before it asks,
  and there is no race between fetching the kit and loading a restored
  session's voices. It used to skip built-ins by checking a hard-coded list.
- **Loaded with `match`, not `unwrap`.** A missing or unreadable bundled sample
  is logged and skipped; any voice naming it then shows red as not found. The
  old `ride` load unwrapped, which would have made a bad resource a crash at
  launch.
- **The source files are not all alike and don't need to be.** Kick and snare
  are 24-bit at 44.1 kHz, the snare stereo; the hi-hat is 16-bit mono at 48 kHz.
  `get_samples_from_filename` decodes through symphonia's `SampleBuffer<f32>`
  (any PCM width) and converts rate and channels at load, so they all arrive as
  device-rate stereo. Checked by a temporary test (run, then deleted) that
  decoded all four through that path.
- **Adding a drum part is a menu**: the kit by name, or *From a file…*. It resets
  to its prompt after each pick, so it reads as an action rather than a setting.
- The kit sounds came from the owner's own sample folder. This is the default
  kit the *Interchangeable drum kits* entry below said was missing; roles
  (`sound?` beside `path`) are still not built.

### The drum grid

`drumGrids` in `defaultJsConfig`, compiled into the Rust config's `drums`.
**`docs/drum-grid.md` is the long version.** An editing surface, never a second
format: what it produces is an ordinary rhythm, gains and chances list, exactly
as if they had been typed.

- **Every column becomes a note, and an unchecked column is a chance of 0.**
  parser2 has notes and spans and no rests, so a pattern with gaps would
  otherwise be written as the gaps *between* hits -- and the first hit would
  then land at time 0 whether or not it was in column 0, needing a rotation or
  a shift from somewhere. It also puts `gains` and `chances` permanently in
  phase, because the hit count now *is* the column count; and a chance of 0
  costs nothing on the audio thread, where a gain of 0 pushes a silent sample
  per column per voice and mixes it for its whole length. So `GridCell` is
  `{chance, gain?}` and the hits view is the chance view rounded to {0, 1}:
  one state, not two that have to be kept agreeing.
- **The lists are one *pass* long, not one period.** A hit index is reduced
  modulo the list's length and the column count divides the emitted note count
  by construction, so `columns` entries land on exactly the column they were
  drawn in. Writing the period out would only repeat itself.
- **`gains` is written only once some cell carries one.** Left alone, a
  hand-typed `1, 0.6x3` survives -- and that list deliberately drifts against a
  bar it doesn't divide, which a grid-owned list can never do.
- **The emitted rhythm covers the whole phasing period.** With `restart` off
  the pulse keeps running across the grid boundary, and there is no way to say
  that in a rhythm that repeats on one pass, so
  `pulse.length / gcd(columns, pulse.length)` passes are written out and the
  checkboxes tile across them. `MAX_LIST_LENGTH` bounds `columns * passes`, and
  going over is **refused**, not truncated -- the last good rhythm stays, like
  any other syntax error.
- **`applyDrumGrids` hands back the same array when nothing changed**, and that
  identity is load-bearing. A grid lives in the js config and sounds out of the
  rust one, so the compile runs from a guarded effect as well as from
  `resolveConfigs`; a pure function whose output is its own fixed point cannot
  loop. Same shape and the same argument as the `visibleChannels` union.
- **`resolveConfigs` is now the only way to resolve config.** Both halves
  together, because resolving either alone leaves a rhythm stale in the one
  config nothing on this side re-reads. Startup, `setParameters` and
  `loadPreset` all go through it.
- **The matrix is a pop-up, and the columns in it are drawn evenly whatever
  the pulse.** The panes are where you look at where a note landed; this is
  where you say what the notes are, and a swung pulse drawn to scale would make
  the short columns the hard ones to hit. The pulse is written above each
  column so the unevenness stays legible, and the grid's own settings moved
  into the pop-up with the cells -- the row in the drums tab is a summary and
  an *Edit...* button, since a grid owns several parts and a matrix, and a
  settings row has room for neither.
- **Beat markers under restart, and none under carry-over.** With every pass
  identical the beats are exact and worth drawing, and with an uneven pulse
  against even columns they land *between* columns at irregular places, which
  is what makes them necessary rather than decorative. With the pulse carried
  over a beat lands in a different column on every pass, so the strip says so
  and the period readout stands in for the markers.
- **One paint value, three lenses, and the same drag writes all of them.** The
  lens switch chooses which field a click or a drag lands in; a hits drag takes
  its value from the cell it started on, so dragging off a hit erases the run.
  A number typed per cell was the alternative and is unusable at 128 columns --
  and "make these four hits quiet" wants one gesture, not four. The value draws
  as the cell's shade in the lens's own hue, with the number printed while
  there are sixteen columns or fewer.
- **Gains and chances only touch a cell that already sounds**, which is what
  keeps the gains lens from writing a gain into every cell just by being
  opened: `gains` appears only once somebody paints one, and *clear gains* is
  the way back to a hand-typed list.
- **A new row and a new column arrive silent.** The first pass made them sound,
  because a silent row had nothing to say it had been added; the matrix is that
  something, and it inverts the argument -- you add a part in order to program
  it, and lengthening a pattern must not add hits nobody asked for.
- **A row names its voice by index**, like `sections[].drums`, so deleting a
  voice has to fix the indices up -- `removeDrumVoice` does both edits as one
  operation. **`sections[].drums` has exactly the same bug and still does
  not**: nothing re-indexes a section's drum list when a voice is deleted, so
  deleting voice 0 silently shifts what every section mutes. A stable voice id
  would fix both, and is a wider change than either feature.

### The file player

One file, played along with, looping. `playFile` switches it, `fileVolume` is
its output gain, and it appears as the third synthetic bus so it can be drawn
against your own playing like any other channel.

- **The read position is derived from `beat`, never accumulated.** This is the
  whole of the sync fix. `mp3.pos` used to be a counter incremented once per
  output channel and wrapped at `buffer.len()`, with nothing anywhere
  reconciling it against the beat clock -- they agreed only at a beat reset, and
  any mismatch between the file's length and its length in beats added up, one
  wrap at a time, without bound. A bounce 40 frames longer than exactly 8 beats
  is 4505 frames -- 102 ms -- out after ten minutes, which is what "it slowly
  goes out of sync" was. Simulation-checked both ways: derived lands within one
  frame of the file's start on every eighth beat over the same ten minutes.
- **`fileBeats` is what makes that possible, and 0 means "don't".** Above zero
  the file is phase-locked: `phase = (beat - fileShift) mod fileBeats`, times
  the frame count. At 0 it free-runs at its natural rate off `Mp3Buffer::pos`,
  which is the old behaviour minus the bugs -- and is not locked to anything, so
  it will still slide against the grid. That's honest rather than fixable: a
  file whose length nobody has declared has no beat.
- **A rounded bpm cannot slide the file off the grid.** With the position
  derived from `beat`, tempo only sets the playback *rate*; the file still hits
  its start exactly on the beat. That is why `set tempo from file` can round to
  four places -- the residue is a millionth of a semitone of varispeed, not a
  drift.
- **Declaring a length that isn't the file's natural one is a varispeed**, and
  the read interpolates for it. At the natural rate `frac` is 0 and the read is
  an exact sample copy, so nothing is filtered that needn't be.
- **`fileOffsetMs` and `fileShift` are the drum `offset`/`shift` split**, for
  the same reasons: ms is mechanical (a bounce whose downbeat sits a few ms in),
  positive *earlier*; beats is musical placement and is tempo-independent.
- **The rate and channel count were decoded and thrown away**, which was two
  silent bugs at once: a 44.1k file on a 48k device played 8.8% fast, and a mono
  file played an octave high because the position advanced once per output
  channel. `decode_audio_file` now returns them and `to_device_stereo` converts
  **at load**, off the audio thread -- linear interpolation, and mono goes to
  both sides at full level rather than being panned. `get_samples_from_filename`
  is that pair composed, so the drum voices were fixed by the same change.
- **`mp3_loaded` was captured at startup from a hard-coded path**
  (`/Users/eric/Music/Logic/tauri-file.wav`), so on any machine where that file
  doesn't exist, picking a file decoded it and then never played it. The
  callback asks the buffer instead. The startup path is still there and still
  personal; nothing depends on it any more.
- **Loading a file no longer resets the beat.** It used to, because that reset
  was the only thing that ever aligned the two clocks. Now the file is locked to
  the beat by construction, so restarting the clock to line a file up is neither
  needed nor wanted mid-practice.
- **A-B repeat is the same formula with a different cycle.** `fileRepeatOn`
  plus `fileRepeatStart`/`fileRepeatEnd`, in the *file's* beats, cycles over
  that segment instead of the whole file; off, the segment is `0..fileBeats`,
  which is the pre-existing arithmetic exactly (checked position-for-position).
  The segment repeats on **its own length**, so a 3-beat A-B against a 4-beat
  grid deliberately walks around the bar rather than resetting -- the same
  choice drum `gains` and `rowColorPattern` make.
- **The segment may cross the file's end.** There are two wraps: the phase into
  the segment, then the resulting file beat into the file. So `14..18` of a
  16-beat file is the last two beats followed by the first two, which is how you
  loop a pickup. Nothing can index outside the buffer -- checked by sweeping
  50 beats either side of zero for segments that are negative, wrapping, tiny
  and entirely past the end.
- **A backwards or zero-length segment falls back to the whole file** rather
  than being refused, because it's a state you pass through while typing the
  other end. Same for A-B with no `fileBeats`: a position in beats means
  nothing until a length in beats has been declared, and the panel says so
  rather than silently doing nothing.
#### Time stretching

`fileStretch` renders the file to fit `fileBeats` at the current tempo without
moving its pitch. **`docs/` has nothing on this; `stretch.rs` is the reference.**

- **Nothing about it runs on the audio thread, and that is the whole design.**
  The ratio changes only on a config event, and the file is known in advance, so
  the entire file is re-rendered on a worker thread and the result swapped in.
  The render callback is untouched: it still reads a plain buffer at a position
  derived from the beat. This is the same shape as the load-time resampling, for
  the same reason.
- **The ratio needs no new setting.** `naturalBpm = fileBeats * 60 /
  naturalSeconds`, and the ratio is `naturalBpm / bpm` -- both numbers are
  already on screen. The frontend derives it independently for display rather
  than asking Rust, since it is a consequence of two fields it owns.
- **WSOLA, not a phase vocoder**, although `realfft` is already in the tree and
  would have made one easy. A phase vocoder smears transients, and smeared
  transients are exactly what this app exists to let you place. WSOLA is
  overlap-add with a similarity search choosing where each grain is cut from,
  which is what keeps successive grains in phase.
- **Both buffers are circular.** The file is going to be looped, so wrapping the
  overlap-add across the end is what makes the loop point seamless instead of a
  fade to silence every cycle. Measured: block peaks stay within 0.999-1.000
  across the seam.
- **The render is rounded to a whole hop, and that cannot desync anything.** The
  read position is a fraction of *whatever length the buffer turns out to be*,
  so the file still spans `fileBeats` exactly; the rounding shows up as a
  ~0.05% difference in playback rate and nowhere else. This is the same property
  that lets `set tempo from file` round to four places.
- **`natural` is kept alongside `buffer`.** Every render is computed from the
  unstretched source, never from the last stretch -- restretching a stretch
  compounds artifacts, and the ratio moves every time the tempo does. Costs a
  second copy of the file in memory.
- **A `generation` counter is what makes it safe to ask on every keystroke.**
  The frontend pushes a config per keypress, so typing `120` is three requests.
  Each bumps the counter; a render that finishes holding a stale one is dropped
  rather than applied over a newer answer. A 200 ms debounce in front of it
  means the superseded ones usually never start.
- **The swap allocates and frees outside the lock**, and `mem::replace`s the old
  buffer out to be dropped after unlocking. The callback holds this mutex for
  its whole run, so a 23 MB free inside it is time the audio thread waits.
- **Lock order is config, then file** -- the same order the callback takes them,
  which is why `set_config` drops the config guard before requesting a stretch.
- **Quality is honest to about a third either way.** Measured: a 440 Hz sine
  comes back within 0.5 Hz from 0.5x to 2x, where naive resampling puts it at
  293 Hz at 1.5x. But past ~0.75-1.33 a drum loop starts to flam and sustained
  material warbles, so the panel turns the ratio orange there. Logic's Flex Time
  is much better; bouncing per tempo is still the right answer for big changes.
- 10 s of stereo renders in ~375 ms, which is why there is a `file-stretch`
  event and a `rendering…` note rather than a silent pause.

- **`filePath` lives in the js config** so a session comes back with its file
  loaded -- Rust holds decoded samples and not the path, so the frontend pushes
  it back through `set_mp3_buffer` **whenever the path changes**, tracked by a
  ref against the last one pushed. It used to be pushed once on mount, and
  picking a file decoded it directly, which left exactly one way for the path to
  change without a decode: *loading a preset*. The new preset's `fileBeats` and
  stretch then applied to whatever file was still in memory, which came out as
  the old file playing back stretched wrong.
- **An empty path is "no file", and `set_mp3_buffer` takes it.** A preset that
  has no file has to be able to stop the last one, so the empty path clears the
  buffer rather than erroring. It swaps the samples out and drops them *after*
  unlocking, for the same reason the stretch swap does -- the render callback
  holds that mutex for its whole run. `generation` is bumped so a render already
  in flight for the old file lands nowhere. `set_mp3_buffer` returns a
  `FileInfo` (frames, seconds, source rate and channels, device rate), which is
  what the panel prints and what `set tempo from file` divides.

### The analysis stream and the spectrogram view kind

A second stream, deliberately separate from `VisualSamples` so the per-frame path
is untouched: `analysis.rs` runs a Hann FFT every `window / 4` frames per input
channel, groups the magnitudes into 64 bins and sends them as `u8` decibels.
`views[i].kind = "spectrogram"` draws them instead of the waveform; everything
else about the pane -- rows, margins, grids, `getCanvasPositions`, the sweep --
is unchanged.

- **The window is a setting, `analysisWindow`**, one of `ANALYSIS_WINDOWS`
  (256/512/1024/2048/4096), default 1024. It is the frequency-vs-time trade, and
  **the hop is always a quarter of it** so one control moves the smear, the
  column width and the flux's precision together while the overlap stays at the
  conventional 4x. A dropdown, so a plain number rather than an expression.
  Anything not in the list snaps to the nearest that is. Global, not per-pane:
  one FFT feeds every pane and the flux.
- **Changing the window allocates nothing.** Every size is planned at startup
  and every buffer is sized at `MAX_WINDOW`, so `configure` only recomputes the
  Hann table and the bin edges in place. `realfft` wants `input` and `spectrum`
  at exactly the transform's length but only requires `scratch` to be *at least*
  long enough, which is why one max-sized scratch serves every plan and the
  other two are sliced. Pointer-identity checked.
- **A shorter window makes the low end worse**, in the specific way `edges`
  already documents: wherever log spacing asks for finer than the window's
  resolution the axis is one bin per group, i.e. linear, and a shorter window
  pushes more of the axis into that regime. That is the cost of the trade, not a
  bug to fix.
- **All the FFT state is in one `Analyzer`**, built before the render closure so
  the planners and scratch buffers are allocated once. `configure(channels,
  window)` is called once per callback next to `bus_delay.resize`; `push` per
  frame, next to where `input_frame` is filled -- *not* inside the
  per-output-channel loop. Reset on beat reset, while paused, and on either
  change, so no window is stitched across a gap and no spectrum is differenced
  against one grouped by different edges.
- **The stamp is the window centre.** A hop completing at frame *i* describes
  the window centred `window_len/2` frames earlier, so it is stamped
  `visual_beat - (window_len/2) * beats_per_sample` -- the sample stream's stamp,
  less half a window, **read from the analyzer** since the window moves.
  Attaching it to frame *i* draws every column a whole half window late: ~92 px
  at `0.25x16` and 140bpm with the default window, which reads as the FFT being
  broken rather than the stamp. (Simulation-checked, along with the flattening
  index below.)
- **The flux scale is stable across windows.** Magnitudes are normalised by the
  window length, so a hard 1 kHz attack measures ~0.30-0.32 at every size --
  changing the window must not move the picture's brightness or make a threshold
  mean something different. Measured, not assumed.
- **The `u8` contract is fixed at -100..0 dB.** 0 is silence, 255 is full scale.
  Deliberately wide, because `spectrogramGain` and `spectrogramFloor` are applied
  in the frontend: tuning the picture must never push config to the audio thread.
- **The stream is flattened** the same way and for the same reason as the
  samples: `mags[(hop * channels + ch) * bins + bin]`, `beats` one per hop.
  `channels` is the *analysed input* count, capped at `MAX_ANALYSIS_CHANNELS`
  (4) -- device channel order, not the `visibleChannels` subset, so
  `spectrogramChannel` indexes it directly. The synthetic buses have no spectrum.
- **`analysisOn` is the off switch**, default true. Not derived from whether any
  pane is a spectrogram: that would mean writing rust config from a render.
- **A column is as wide as the gap since the last one.** Hops arrive 172 times a
  second, which at high zoom is dozens of pixels apart, so a one-pixel line per
  hop would draw a picket fence. The column is painted *backwards* from the
  hop's x -- it covers the span ending at that beat. At low zoom several hops
  share a pixel and the per-bin max wins, so the flush boundary here is a whole
  pixel column (`Math.floor`), unlike `drawSweep`'s float compare.
- **Grids are drawn per column, clipped to it, after the spectrum.** A column
  fills the row height, so grids have to go on top; repainting the whole pane's
  grids every frame instead would composite a sub-1 alpha to opaque in a few
  frames.
- `refreshAtCycleEnd` is ignored for spectrogram panes. Sweep only.

### Onsets

Peak picking over the flux, in `Analyzer::pick_onset`, reported as sparse
`Onset { beat, channel, strength }` on the same stream. `views[i].showOnsets`
draws each as a short tick at the row's edge in the channel's colour -- short
and at the edge so it can't be mistaken for a grid line, which is the thing it
exists to be read against.

- **Three standard conditions**: largest within `peak_radius` either side,
  standing `onsetThreshold` above the *median* of the `median_back` hops behind
  it, and at least `onsetMinGap` after the last onset on that channel. Median
  rather than mean because a mean is dragged up by the very peaks being
  detected, which suppresses the next one.
- **The spans are in milliseconds, not hops** (20 ms radius, 100 ms median),
  converted in `retune`. Fixed in hops they would silently become 70 ms of
  lookahead at a 4096 window and 1.5 ms at 256.
- **The picker runs `peak_radius` hops behind**, because a candidate needs
  neighbours on both sides. That is the only latency it adds on top of the half
  window, and it is affordable exactly because the display already runs
  `buffer_compensation` behind the audio.
- **Nothing is reported for 60-140 ms after a reset**, depending on the window:
  the guard waits until a candidate has a full median behind it and a full
  radius in front. Not a bug -- a peak picked across the gap would be measured
  against a median from before it.
- **`ONSET_CENTRE_BIAS = 0.32` is a measured correction, not a fudge.** The hop
  stamp names its window's *centre*, which is right for a spectrogram column and
  wrong for an onset: the flux peaks when a transient *enters* the window.
  Measured against clicks at known frames the lead came out at
  0.303/0.318/0.321/0.336/0.321 of the window for 256..4096 -- proportional and
  otherwise constant. Uncorrected it is ~60 px at `0.25x16` and 140bpm.
  With it, reported times land within half a hop at every window.
- **`onsetOffset` (ms) is the trim on top**, because that 0.32 was measured on an
  instant attack and a slow-attack instrument sits differently. The drums bus is
  the reference to calibrate against -- the callback knows its trigger times
  exactly, which is the one thing in this app that has only ever been set by ear.
- **Sub-hop placement.** A parabola through the candidate and its two neighbours
  recovers the peak between them; a hop is 5.8 ms at the default window, which
  is ~46 px at the zoom levels in use, so the hop grid alone would be the
  binding limit on a tool about where an attack sits.
- Onsets carry their own beat, so they are *not* indexed against `beats`, and
  they survive `barColorMode` (a tick sits on top of the shading) where the flux
  does not.

#### Running the picker over a file

`src-tauri/examples/onsets.rs`. Until this existed there was no way to ask
"where does this algorithm say the notes are" about anything but live audio,
which is why *where the onsets land* stayed open for so long: every attempt to
judge it was an attempt to judge a moving picture by eye.

```
cargo run --release --example onsets -- analyze take.wav [--expect f1,f2,...]
cargo run --release --example onsets -- synth samples/snare.wav --at 20000,60000
```

- **It drives the real `Analyzer`, frame by frame, in exactly the order
  `main.rs` does** -- `push`, `note_hop_beat`, `analyze_into`, `pick_onset`,
  `advance_hop`. What it reports is what the app would have drawn.
- **Onsets come out in frames because `beats_per_sample` is 1.** The analyzer
  stamps in beats, so feeding it 1 and a hop stamp in frames makes "beats" *be*
  frames -- nothing is converted, and the arithmetic under test is the
  arithmetic that ships.
- **`synth` is the half that needs nobody's recording.** It places a sample at
  frames it chooses, so the ground truth is exact by construction rather than
  measured off a picture. That is what the drums bus was always for -- the
  callback knows its own trigger times -- without having to play anything
  through a room.
- **An `examples/` target rather than a second `[[bin]]`**, because cargo
  builds examples only when asked: `yarn tauri build` neither compiles it nor
  gains its warnings. Confirmed -- the ordinary build still reports exactly the
  three.
- **It includes `analysis.rs` by `#[path]` and stands in its own `Onset`.**
  `structs.rs` reaches into `bleed`, `calibration` and `recorder`, and
  `constants.rs` into Core Audio and the whole `Config`, so including either
  would drag in the app to test one file. The stand-in is the same shape, and
  if the real `Onset` gains a field this stops compiling -- the right kind of
  failure.
- **Its WAV reader is its own**, ~60 lines over PCM 16/24/32 and float32,
  rather than symphonia: that path goes through `constants::sample_rate`, a
  process-global `OnceLock`, and a harness whose whole job is timing has no
  business inheriting a rate from anywhere but the file.

##### The threshold, 2026-09-20

**`onsetThreshold` went 0.05 to 0.4**, which is the single biggest thing wrong
with the onsets and is now measured rather than argued. Swept against 61
seconds of isolated guitar notes (7 of them, ground truth taken independently
from the amplitude envelope) and against all four kit sounds placed at exactly
known frames.

| threshold | guitar found | guitar false | ride false |
|---|---|---|---|
| 0.05 (old) | 7/7 | **259** | 18 |
| 0.1 | 7/7 | 11 | 0 |
| 0.3 | 7/7 | 3 | 0 |
| **0.4** | **7/7** | **0** | 0 |
| 0.45 | 7/7 | 0 | 0 |
| 0.5 | **6/7** | 0 | 0 |

- **The old number came from a sine.** The existing note said a sustaining tone
  reads under 0.01, which made 0.05 look safely clear of it. A cymbal's decay
  and a guitar's ring-out are not sines, and both walk straight through it.
- **The guitar decides the whole sweep.** The drums are flat from 0.08 to 0.6 --
  a drum attack measures 1.3-1.8 where a guitar note measures 0.44-0.92, so
  tuning on drums alone would have left the threshold anywhere in a range that
  silently loses half of real playing. That is what the recording was for.
- **0.4 is mid-plateau, and the plateau is narrow**: 0.5 already loses a note.
  Taken anyway, because 0.4 is *exact* on the only real material there is --
  7/7 and nothing false -- and backing off to buy headroom against playing
  nobody has recorded yet trades a measurement for a guess. Soft playing is the
  untested case and the next recording to make.
- **A session carrying exactly 0.05 is migrated to the new default**
  (`migrateRust`). Restore merges saved values over the defaults, so otherwise
  every existing install would keep the flood this exists to fix -- the
  `loopFeedback` trap reached from the value side rather than the meaning side.
  Only *exactly* the old default moves; any other number was typed on purpose.
  Temp-tested both ways, then deleted.

**Two things deliberately not changed.**

- **`analysisWindow` stays 1024.** Swept: the drums get *sharper* the shorter
  the window (256 is exact, zero spread) but the guitar misses up to five of
  seven below 1024, and lateness grows monotonically with window on every
  sound. 1024 is the only size that finds all seven. The window is purely a
  guitar-versus-drums compromise, which is the axis to remember if per-pane
  analysis tuning is ever wanted.
- **The band stays 30-16000 Hz.** The "exclude the fundamental and the attack
  sharpens" hypothesis is **wrong**: 30 to 400 Hz moves the guitar's median by
  0.1 ms and its spread by 0.1 ms. 800 Hz costs a note.
- **`onsetOffset` stayed 0 here, and that was wrong.** The reasoning was that
  a 3.8 ms trim is noise against a 44 ms spread -- true, but the 44 ms spread
  was an artifact of the ground truth, and there is no spread of that size to
  be noise against. Superseded the same day by *The late bias*, below.

##### The late bias, 2026-09-20

**Everything is reported late, and the measurement that said otherwise was
measuring against the wrong zero.** Found by the owner looking at the running
app for the first time -- every tick sitting a consistent distance to the right
of the note it marked -- which is exactly the check *not seen in the app yet*
was there to prompt.

**Where "note start" is put decides the sign of the answer**, and that is the
whole of the earlier mistake. The ground truth used for the threshold sweep
was a crossing of 5% of full scale; a guitar note takes 20-30 ms to climb
that far, so the zero was already deep inside the note and half the errors
came out negative. The eye does not use that definition. Looking at a
waveform, the note starts where the trace first leaves the baseline -- so the
ground truth has to be the first departure from the noise floor, and against
it nothing is early:

| sound | error vs first departure |
|---|---|
| snare | +0.7 ms |
| hi-hat | +2.2 ms |
| ride | +3.5 ms |
| kick | +7.0 ms |
| guitar, four notes | +3.5 to +4.8 ms |
| guitar, three notes | +23.5 to +29.3 ms |

- **Eleven sounds, eleven late.** That is a bias, not a scatter, so the median
  of 4.6 ms is a constant to subtract rather than the middle of a range.
  `onsetOffset` defaults to **-4** -- rounded down so the sharpest attack
  available (the snare, +0.7) comes out 3.3 ms early, inside the half hop the
  sub-hop parabola is clamped to and so under the resolution of the thing
  doing the measuring.
- **It changes placement and nothing else.** Still 7/7 on the guitar with no
  false positives; the trim is added after every test in `pick_onset`.
- **A session carrying exactly 0 is migrated**, like the threshold before it.
  0 was the default, not a decision, and restore merges saved values over the
  defaults. The cost is that a deliberate 0 is indistinguishable from an
  untouched one and moves too.
- **The kit's own numbers got worse under the honest definition, and that is
  the point.** The kick was recorded at +1.5 to +2.7 ms against a 10%-of-peak
  lead-in; against first departure it is +7.0, because the kick genuinely
  takes 5.9 ms to climb from the floor to 1% of full scale. The old table was
  flattering the detector by handing it a late zero on both sides.

**What the trim does not fix** is the three guitar notes at +23.5 to +29.3,
which sit ~20 ms out even after it. Those are the ones whose envelope ramps
gradually between 4x and 10x the noise floor -- a soft swell of 5-13 ms before
the string really speaks -- where the other four depart abruptly. So the
remaining error is *not* uniform and no constant absorbs it.

- **Do not read a rise-time law into it.** r = -0.87 against rise time looks
  strong and is not evidence: the seven notes fall into a cluster of four and
  a cluster of three, and any variable separating those two clusters scores
  that well. Position in the file scores +0.64 on the same seven points. What
  separates the clusters is unestablished, and seven notes cannot establish
  it.
- **The earlier claim that it is not attack softness (r = +0.037) is
  withdrawn**, along with the claim that one note is ambiguous at -20.1 ms --
  both were computed against the 5%-of-full-scale zero and neither survives
  the change of ground truth. The *direction* the kit suggested all along --
  slower attack, later report -- is the one thing that does survive: snare
  +0.7, hi-hat +2.2, ride +3.5, kick +7.0, in attack order.
- **The material to settle it is the same one already wanted**: the same note
  at several pitches, and quiet playing. Level and register are the candidates
  this recording cannot separate.
- **A sub-threshold neighbour used to steal the slot.** At low thresholds a
  weak noise peak 30-50 ms *before* a note is accepted first, and `onsetMinGap`
  then suppresses the real onset -- so the reported time was the *next* peak,
  tens of ms late. That is why the guitar's median improved as the threshold
  rose, and why a larger gap was worse than 40 ms at low thresholds. Raising
  the threshold removes it in practice; the principled fix is to prefer the
  strongest candidate within a gap rather than the first, which is a change to
  `pick_onset` on the audio thread and is **not** made here.

##### What the kit found, 2026-09-20

First run, against the built-in kit, before any guitar was recorded. The
figures below subtract each sample's own lead-in -- measured separately as the
first frame above a tenth of its peak -- so they are the *algorithm's* error
and not the file's.

**The lead-in definition is too generous and these errors are understated**;
*The late bias* has the same sounds against first departure from the floor,
where the kick is +7.0 rather than +1.5 to +2.7. Kept as written because the
*ordering* it establishes -- sharper attack, smaller error -- is the finding
that survived, and because it is the measurement the threshold work was done
on top of.

| sample | its own attack | reported | error |
|---|---|---|---|
| snare | 0.05 ms in | +0.20 ms | **+0.15 ms** |
| hi-hat | 0.06 ms in | +1.0 to +3.2 ms | +1 to +3 ms |
| kick | 5.90 ms in | +7.4 to +8.6 ms | +1.5 to +2.7 ms |

- **`ONSET_CENTRE_BIAS = 0.32` is right, and confirmed by something other than
  the ear that set it.** A sharp attack lands within a fifth of a millisecond.
- **The error grows as the attack softens**, which is the thing `onsetOffset`
  cannot fix: it is one number, and this is not a constant. A plucked string
  sits further along that same axis than a kick does, which is precisely why
  the guitar recordings are still wanted.
- **`onsetThreshold` at 0.05 is far too low, and that is the bigger finding.**
  A real attack measures 1.3-1.8 here, so the default sits *twenty times*
  below one -- and what gets in is a cymbal's own decay. A ride reported **21
  onsets for 3 hits**, a hi-hat 5 for 3, each spurious one landing exactly
  `onsetMinGap` after a real one and measuring 0.078 against the real 1.75.
  Every threshold from 0.1 up reports exactly 3 on all four sounds. The
  existing note that "a sustaining note reads under 0.009" was measured on a
  *sine*, and a cymbal is not one.
  - Not changed yet: what a quiet fingerpicked note measures is the other half
    of the decision, and that is what the guitar file answers.

#### Spectral flux

The onset detection function, computed in `analyze_into` next to the
spectrogram's bytes and sent on the same stream: `flux[hop * channels + ch]`,
one f32 a hop a channel, unclamped.

- **It rides here rather than in the sample stream on purpose.** A hop describes
  the window centred `WINDOW/2` frames back, and a per-frame value can only be
  stamped *now* -- so putting the flux in `VisualSamples` would need a 512-frame
  delay line on every other channel and the whole display shifted to match. This
  stream is already stamped at the window centre, so there is nothing to align.
  `buffer_compensation`, the sample stamp and `bus_delay` are untouched by any of
  it. `docs/onsets.md` has the long version.
- **Log domain, not linear.** The sum of positive frame-to-frame change in *dB*,
  so the same attack reads about the same whether it lands in a quiet passage or
  a loud one -- which is what lets a threshold over it be one setting rather
  than one per dynamic. Falls don't count: a note decaying is not an onset.
- **The dB values are floored at -100 dB before either consumer sees them.** The
  `u8` never noticed, since anything under the floor already clamped to 0. The
  flux does: a bin holding numerical noise sits near -300 dB and wanders tens of
  dB a hop, and without the floor that noise was most of the number. Found by
  test, not by reading.
- **Normalised per bin, not per band.** Divided by 20 dB (a factor of ten in
  amplitude, roughly what a bin does under a transient) *and* by the number of
  groups actually in the band, so narrowing the band doesn't rescale the curve.
  A strong full-band attack measures around 2.3, so the useful `fluxGain` is
  below 1 -- it defaults to 0.3 over a 0.05..4 slider. The normalisation is
  about a threshold meaning the same thing at any dynamic, not about the curve
  filling a row.
- **`analysisBandLow` / `analysisBandHigh`, in Hz** (30 / 16000) are how you stop
  a bass note reading on a snare's detector. Expression-backed, so they are
  registered in `RustExprKey`, `RUST_EXPR_FIELDS` and `RUST_EXPR_KEYS`.
  `Analyzer::band_groups` turns them into a group range **once per callback**,
  from the groups' real spans rather than the nominal log spacing, and falls back
  to the full range for anything unusable -- reversed, non-finite, or covering no
  group.
- **The first hop after a reset reports 0.** Its "previous" spectrum is the
  zeroed buffer, which every bin is far above, so it would read as a full-scale
  onset on every unpause. `hops_since_reset` is a count rather than a bool
  because `analyze_into` runs once per channel and the state has to outlast all
  of them; `reset()` clears it and `prev_db` along with the ring.
- **Drawn after `drawSweep`**, which erases each column immediately before
  redrawing it -- draw the flux first and it is wiped. It lands a few pixels
  *behind* the sweep cursor, because its stamp is half a window older than the
  newest sample. That is the stamp being honest, not lag.
- Per-view `showFlux` / `fluxGain` are plain values, not expressions: a checkbox
  and a slider have nowhere to type one. Both draw modes work --
  `fluxColumns` mirrors `cycleColumns` for `refreshAtCycleEnd`, collected before
  the wrap check because a cycle's last hops arrive after its samples have
  wrapped.
- **Indexed by device channel, not by stream slot.** The sample stream is packed
  in `visibleChannels` order; the analysis stream is in device order, so
  `drawFluxAt` reads `peaks[visibleChannels[slot]]` and draws it in
  `visibleStyles[slot]`'s colour. A slot pointing at a synthetic bus has no
  entry and is skipped -- the buses aren't captured, so they have no spectrum.
- Skipped for spectrogram panes and in `barColorMode`, both of which fill the
  row height: there is nowhere to put a second signal.

## Failing loudly

A config push is all-or-nothing and used to fail in silence, which cost a
debugging session on 2026-09-06: a click rhythm of `0` made the panel look
completely dead -- pause, mute, every button -- while the audio carried on
exactly as before.

- **Tauri deserializes a command's arguments before the command runs**, so one
  bad field means the *whole* `set_config` is refused and Rust keeps whatever it
  last accepted. Nothing in the panel changes: React state updates, the checkbox
  ticks, the field is green. Only the sound disagrees.
- **The trigger was `JSON.stringify(NaN) === "null"`**, and serde will not take
  `null` for an `f64`. `parser2`'s `Result` rule wraps every note into the cycle
  with `t % endTime`, which is NaN when `endTime` is 0 -- so `"0"`, `"4:0"`,
  `"0:1"` and `"1/0"` all parsed *successfully* into a config that could never
  be sent. The grammar rejects a non-positive or non-finite span now, the same
  way and for the same reason it rejects a repeat count below 1.
- **`invoke("set_config")` now has a `.catch`** and the panel shows a red banner
  saying what you are looking at is not what is playing. This is the fix that
  matters: the grammar hole is closed, but the next one won't be, and a push
  that fails has to be visible rather than inferred from the sound not changing.
- **A saved session was the worse half.** The session is written on every config
  change, so a `null` time went to local storage and came back at launch --
  rejecting every push from the first render, before anything could be retyped.
  `sanitizeRhythm` in `presets.ts` swaps an unusable `val` for the default's
  while keeping `inputText`, so the field still shows what was typed and still
  reads red. Applies to `audioSubdivisions` and each drum voice's rhythm; the
  view grids don't need it, since they never leave the frontend and `drawGrids`
  already skips a non-positive span.
- **`resolveRhythm` refuses an unusable re-parse too.** A parameter can make a
  rhythm degenerate without the field being touched -- `n:1` with `n` set to
  0 -- and there's no input component watching that path to turn red.
- **Two audio-thread guards, independent of all of the above.** `beat_bisect`
  falls back to its default cycle when the span isn't finite and positive:
  `beat / 0` saturates the loop count to `isize::MAX` and then *overflows* to
  `isize::MIN` on the way out, which in release wraps silently and stops the
  click triggering at all. And `mod_add` returned into a `while res >= max`
  loop that never terminates when `max` is 0 -- a hung render callback holding
  every lock the IPC thread needs, which is the worst failure available here.
  Both are O(1) and neither depends on the frontend having validated anything.

## Known issues / latent bugs

- ~~**Mono audio files play at double speed.**~~ -- **fixed 2026-09-06.**
  Everything is converted to interleaved stereo at the device rate on the way
  in, so `sounding_samples[j].pos += 1` per output channel is now a correct
  assumption rather than a lucky one. See *The file player*.
- ~~**A saved device was only checked for existing, not for being able to do
  its role.**~~ -- **fixed 2026-09-19.** A microphone saved as the output
  device panicked the process at launch, before any window. See *Device
  selection*.
- ~~**Any read of `sample_rate()` froze it at the 44.1 kHz fallback.**~~ --
  **fixed 2026-09-19.** The kit was decoded before the device was opened, so
  both the samples and the input stream format were at the wrong rate. See
  *Input capture*.
- **`describe()` in the device picker prints the input channel count in both
  lists**, so a 4-in/4-out interface under *Output* reads "4 ch" meaning its
  inputs. Cosmetic.
- **The channel count `2` is a magic literal** in the output stream format and
  `if ch == 0 || ch == 1`. Untangling these into one constant is prerequisite work
  for any further channel changes.
- **The click counter ticks twice per frame** (once per output channel), so
  `click_sound_counter = 400` is really 200 frames. Moving it out of the output
  loop would double the click's length — halve the constants if you do.
- A zero-length `beatsToLoop` used to panic; guarded now, but similar bare
  indexing exists elsewhere.
- ~~`SAMPLE_RATE` hard-coded at 44100~~ -- **fixed 2026-09-06**, adopted from
  the input device instead. See *Input capture*. The rate is still read **once**
  at startup: changing the device rate in Audio MIDI Setup, or switching the
  default input device, while the app is running is not picked up and needs a
  restart.

## Verification

**The owner tests everything that gets made, in the real app, and usually
without saying so.** Treat a feature as heard and seen unless a note below says
otherwise. The dated sections that follow record what was *new and unconfirmed
at the time of writing* -- they are a build log, not a standing list of doubts,
and several of them have since been confirmed. What is genuinely open is here:

- **Onsets: the threshold and the late bias are both measured and fixed.** See
  *Running the picker over a file*. `onsetThreshold` 0.05 -> 0.4 takes 61
  seconds of guitar from 269 reported onsets for 7 notes to exactly 7, with no
  misses, and a ride from 21 for 3 hits to 3. `onsetOffset` 0 -> -4 takes out
  the systematic lateness the owner saw in the app -- see *The late bias*,
  which is also the entry that records the offline measurement having been
  made against the wrong definition of "note start".
  - **The trim has not been looked at in the app**, which is the whole of what
    it was built to fix, so the number to trust is whatever the owner ends up
    dialling while watching their own playing rather than -4. It is a live
    control in the analysis section and the eye judging it is better ground
    truth than any file here.
  - **Still open**: three of seven guitar notes are ~20 ms late even after the
    trim, and what separates them from the other four is unestablished. Also
    untested: whether 0.4 holds for playing quieter than the recording.
- **`buffer_compensation` at 48 kHz.** Tuned by ear at 44.1 kHz, so ~8 ms short
  on a 48 kHz device. `measure latency` answers this in about ten seconds.
- **Speaker bleed has never been tried against a real speaker.** The whole
  chain is simulated against a modelled room and a modelled nonlinear speaker,
  and the two *rejected* designs were both killed by measurement rather than by
  argument (see *Speaker bleed*). What no simulation can say is whether a real
  laptop's response fits in 11.6 ms, whether a measurement holds while you move
  around in front of the machine, how much of the real ceiling is the speaker's
  distortion, or whether what is left is actually easier to play against. The
  first thing to look at is the number the measurement itself reports.
  **Roughly two thirds of the drums and click removed, 2026-09-13**, on the
  laptop's own speaker and microphone, with hands in playing position -- helpful
  rather than transformative, and well short of the simulated ceiling. Where the
  rest of it goes is the open question: the speaker's own DSP, a response longer
  than 11.6 ms, and drift between measuring and playing are the candidates, and
  the measurement's own figure against the live one separates them.
  **The measure button reported 14.8 dB on that machine**, against roughly 10 dB
  observed -- so the limit is mostly in the *fit*, not in drift between
  measuring and playing. That points at the response being longer than the
  11.6 ms window, or at the speaker's own DSP, and widening `TAPS` is the cheap
  thing to try. Tracking helped visibly when the laptop was repositioned, which
  is exactly what it was built for. Not looked at at all: the looper path, and
  the live readout -- whose first version only showed a number while it was
  *learning*, which is almost never.
- **The looper on speakers, 2026-09-13, and then a regression.** Cancelling the
  bleed out of what the looper records **works**: previously it fed back and was
  loud after ten passes, now the loop fades and a clap is gone in about five.
  What remained was a high-mid band accumulating over a couple of minutes.
  `loopFeedbackGuardOn` was built for exactly that, and the owner's report on
  first use was that **it seems to have got worse**. Left there deliberately,
  to come back to.

  **Where it was left.** Nothing is forced on: `bleedCancelAudioOn` and
  `loopFeedbackGuardOn` both default to false. But a saved session carries
  whatever was switched on, so *turning both off is the way back* to the state
  that was working.

  **What "worse" refers to is not established**, and that is the first thing to
  settle rather than guess at. The switches bisect it directly, in this order:
  1. `loopFeedbackGuardOn` off, everything else as it was. If that fixes it, the
     guard is the culprit and the suspects below apply.
  2. Then `bleedCancelAudioOn` off as well, which returns to the picture-only
     feature that was confirmed good at roughly two thirds removed.
  3. If it is *still* worse, the regression is in the restructure that came with
     the audio path, not in either switch -- see the last suspect.

  **Suspects, most likely first.**
  - **The guard cutting music rather than feedback.** It deepens the loudest
    band that has grown three intervals running, and a part being built up grows
    exactly like a runaway does. `STEP_DB` is 1 dB per second with `RELEASE_DB`
    only 0.05, so a wrong cut takes twenty times as long to give back as it took
    to make -- that asymmetry is worth revisiting first, and `MAX_CUT_DB` of 24
    is deep.
  - **The guard acting on a loop that was already decaying.** It was simulated
    against a loop that genuinely ran away; it has never been seen against one
    the bleed canceller had already brought under control, which is the real
    case.
  - **Tracking judging itself in the raw domain.** The channel loop was
    restructured when the audio path went in: the reference is now raw and the
    *prediction* is high-passed, instead of the reference being high-passed.
    Mathematically identical for the subtraction, by the LTI argument -- but the
    tracking guard's own `pred_pow` / `err_pow` are now compared on raw signals,
    so low-frequency room noise the filter cannot model inflates the residual
    and holds the guard shut. With the high pass on, that noise used to be
    excluded. This one would show as tracking quietly doing less, and it is the
    only change that could make the *picture* worse.
- **The one-row-per-note button has not been pressed in the app.** The
  arithmetic and the geometry are temp-tested (see *One row per note*), so what
  is open is taste rather than correctness: whether three fields is the right
  number, whether re-seeding on open reads as helpful or as the form forgetting
  what you typed, and whether replacing the pane's grids outright is too blunt
  when there was already a grid worth keeping. The swung case is the one to
  look at hardest -- its half-way markers are written as literals and stop
  following a parameter change, which is invisible until `n` moves.

- **Presets moving to a file has not been through a real launch.** The pure
  logic is temp-tested -- the hash ignores key order and metadata and notices a
  nested change, `uniqueName` fills gaps rather than skipping past them, a
  corrupt file is refused while a corrupt entry is skipped, and `planImport`
  tests id before hash before name and sequences two colliding names inside one
  file. What no test covers is the part that matters most: **the one-time
  migration out of `tpb.presets.v1`**, which runs once and then never again on
  that machine. It is written to leave the old store untouched, so the way back
  is to delete `presets.json` and relaunch -- worth knowing before the first
  launch rather than after. Also unexercised: both native dialogs, the
  quarantine path, and whether a preset exported from one Mac imports cleanly
  on another.

- **The pane placement work and `rowColumns` have not been seen running.**
  Both are geometry, and both are temp-tested where geometry can be: a 1x1
  layout everywhere is position-for-position identical to the old behaviour, a
  300-trial fuzz never produced two overlapping panes, `rowColumns: 1` is
  identical to a verbatim copy of the old `getCanvasPositions` over 600
  off-grid beats in six configurations, and at two columns every instant is
  still drawn exactly once. What that cannot say is whether the pane map reads
  as a map, whether the grow/shrink buttons are the right four, or whether a
  half-empty last strip looks like a bug. The starvation cap in `fitViews` --
  no pane may claim so many cells that a pane behind it has nowhere to go --
  is a judgement call that can shrink a deliberate 2x2 pane when the grid
  shrinks around it.

- **The control restyle has never been looked at**, and it is the change here
  most likely to be wrong on sight: 14px may simply be too small on the
  owner's screen (one line in `index.css`), the custom checkbox's tick is
  drawn geometry that no test can say is centred, and a field recessed to
  `#2b2b2b` inside a `#444` card may read as a hole rather than as a field.
  Two things it deliberately did *not* do, both from the same comparison and
  both bigger: grouping by a tinted band with the caption outside it, instead
  of an outlined card; and a shared vertical axis, so every control in a
  section lines up on one edge the way Audacity's do. Either would be the next
  pass.

- **The section rail has never been looked at.** It builds and typechecks, and
  the structure is simple enough that the risks are all visual: whether ~85px
  off the settings' width makes the denser tabs cramped (Display especially),
  and whether three group headings for seven entries is one heading too many at
  this size. Both are a line each to change. It was built on the panel's right
  first and moved to the left on sight, which is the kind of question only
  looking at it answers.

- **The examples picker has never been opened**, and the two examples in it
  have never been loaded. The store, the parse and both examples' arithmetic
  are temp-tested -- every `val` re-parses to itself through the real parsers
  after a simulated `loadPreset`, no voice names a file, and the authoring
  script's round trip keeps the description while taking the new settings --
  so what is open is whether they teach anything. Hardest first: whether the
  try-this line disappearing the instant anything moves is helpful or
  startling (a settling render after load would take it away immediately, and
  nothing here can rule that out); whether *16ths against the grid* at 80 bpm
  is playable; and whether an uncollapsed Examples section is worth the space
  it takes from the transport.

- **The drum grid has never been opened.** Built in two passes on 2026-09-14
  from `docs/drum-grid.md`. The compile is heavily temp-tested -- the pass
  count over every small (columns, pulse) pair, the emitted rhythm re-parsed
  through the real parser2 with its note times checked against the cumulative
  column starts, the cap refusing rather than truncating, a pre-grid session
  restoring untouched -- so what is open is the surface, not the arithmetic:
  whether painting with one shared value is the right gesture, whether 128
  columns at ~3px is usable at all, whether the settings belong in the pop-up
  or back in the tab, and whether a new row arriving silent is right now that
  the matrix makes it visible. The help area sits *behind* the modal backdrop,
  which `PresetDialog` already lives with and which is more noticeable here.

- **Nothing shipped in v0.3.0 has been used in the app.** Five features built
  in one unsupervised pass on 2026-09-14 -- `chances`, pane names, recording to
  WAV, loop record cycles and the global pause key. Each is temp-tested where
  there was arithmetic to test and each built clean, so what is open is taste
  and the real machine, not correctness. The things to look at, hardest first:
  - **The record cycle against the looper**, which is the one with a real
    design decision in it: a stretch that is not recorded is written as
    *silence*, so a phrase comes back cleanly, and whether "4 off, 4 on" is
    what the field should mean by a bare `4` is a judgement that only playing
    it settles. It is also the thing that was supposed to fix the feedback the
    guard made worse -- worth trying with `loopFeedbackGuardOn` off.
  - **What the recorder does with `paused`**: it records nothing while paused,
    so a file is shorter than the clock. The other answer is silence in the
    file.
  - **The global key.** Whether the press arrives with another app in front,
    and whether ⌘⌥P is free, cannot be known without pressing it. macOS does
    not report a combination already owned by somebody else, which is why the
    panel counts presses instead.
  - **Whether a dropped hit being invisible is a problem.** The row being
    cramped at six controls was the other half of this and is settled -- see
    *One lane per voice*; it got worse before it got better, because
    monospace fields cost about a fifth of their characters.
  - **The pane name's corner, size and opacity**, all chosen without seeing
    them.

- **The unmanaged second Mac has not been retried since the ad-hoc era.** The
  notarized build is expected to install with a plain drag, and the managed work
  Mac now does, but that particular machine has not been asked again.

Confirmed working in the app, whatever the older notes below say: the file
player, A-B repeat, the time stretch, drum offsets, panning, the drums and click
display buses, the multi-tap looper, the spectrogram, the spectral flux, onsets
drawing at all, and ⌘R.

## State as of 2026-08-30

Verified by the owner in the real app: single-channel input, 2-channel input with
up/down split, per-channel looping, the scrollable settings panel, multiple
views, row colours.

Not verified by ear: drum offsets landing where expected, panning, the
drums/click display buses, and the multi-tap looper. The click's timbre was
preserved *by construction* (its counter and per-channel RNG were deliberately
left untouched) rather than by listening.

Parameters and expressions are committed (`variables`, `arithmetic in more
places`) and covered by temp tests that were run and deleted.

The analysis stream, the spectrogram pane and the spectral flux were new here
and had not been looked at yet. Both pictures have since been confirmed legible;
onset *placement* is the part still open (see *Verification*). The arithmetic (hop timing, the
window-centre stamp, the flattening index, the log bin edges) is simulation- and
unit-checked, and so is the flux: silence reads 0, a tone entering reads 2.3 and
under 0.009 across twenty hops of sustain, a decay reads 0, a band excluding the
tone reads 0, the first hop after a reset reads 0, and the spectrogram bytes are
bit-identical to the pre-flux formula. That either picture is legible against
real playing, that the flux spikes on real attacks and not between them, and
that both line up with the grid, are not.

The macOS `Info.plist` and entitlements fix is committed (`documentation &
permissions`) and was verified against a real build with `plutil` and
`codesign`. **Confirmed working 2026-09-06** on a second Mac: the prompt
appears and the bundle captures on its own grant (see the 2026-09-06 note).

Still unchecked on the views work: that a restored pre-views session comes back
with its old rows and grids intact, and that switching arrangement doesn't leave
stale pixels in a pane.

### 2026-09-05

The panel tabs, ⌘P/⌘L, chained panes, the 4x1 arrangement, per-pane channels and
the Restart menu item are all new. The owner has seen the tabs and chaining in
the real app; nothing else here has been used yet.

Checked by temp test (run, then deleted): chained geometry, including that
simultaneous panes are position-for-position identical to the pre-chain
implementation, that a beat is owned by exactly one pane, and that the wrap and
the boundary margins behave; and the channel migration, including a pre-views
session and a pane that chose its own channels.

The audio-thread allocation fix (`DrainSizes`, `MAX_VISUAL_BACKLOG`) was found
while chasing an occasional late drum hit, but **that symptom turned out to
happen in other applications too**, so it was a system-wide glitch and this
fix is not known to have changed anything audible. It stands on its own: the
callback really was calling the allocator every drain, and the cost really did
scale with the channels the panes ask for. Don't read it as a cure.

Not checked: that Restart actually relaunches with audio (an ad-hoc signature
changes every build, so TCC may treat the relaunch as a new app), and that a
pane showing only the drums bus draws what you'd expect -- the buses have no
spectrum, so flux and onsets stay empty there by design.

### 2026-09-06

The bundle was installed and run on a **second Mac** for the first time. It
launches, prompts for the microphone, and captures -- so the `Info.plist` and
entitlements work end to end, which had been unverified since they were written.

Getting there took a long detour, and the cause was mundane: the DMG that was
shipped over was `bundle/macos/rw.tauri-punching-bag_0.1.0_x64.dmg`, an Intel
scratch image from **March 2023**. It predates `NSMicrophoneUsageDescription`
entirely, so it behaved exactly like the original bug -- silence, no prompt, no
Privacy & Security entry -- while every diagnosis was aimed at the current
build's Gatekeeper, TCC and sample-rate behaviour. `codesign -dvvv` names the
architecture and the `Info.plist` entry count in one line and would have caught
it immediately; see **Installing on a second Mac**.

What that detour does and does not establish:

- **Established.** The install recipe (`ditto`, strip quarantine, Open Anyway,
  possibly twice) works on an unmanaged Mac. `codesign -vvv --deep --strict`
  reports the shipped bundle valid on another machine, so the DMG transports the
  signature intact. A self-signed code-signing certificate is a usable free
  alternative to ad-hoc.
- **Not established.** Whether ad-hoc *plus* the hardened runtime is what
  produced `taskgated invalid signature` / `Termination Reason: CODESIGNING 1`
  -- every one of those crashes was the 2023 x86_64 binary, and the current
  build launched without needing the runtime flag dropped.
- **The sample-rate bug was real after all**, and was confirmed separately once
  the correct build was installed: at 48 kHz the waveform is flat, at 44.1 kHz
  it draws. Fixed the same day -- see *Input capture*. Nothing about the fix has
  been heard yet on a 48 kHz device beyond "input arrives"; in particular
  `buffer_compensation` was tuned by ear at 44.1 kHz and its duration is ~8 ms
  shorter at 48 kHz, so the visual alignment there is unverified.
- On a **managed work Mac** the app could not be launched at all. An MDM profile
  or EDR agent enforcing notarization is the likely reason; Homebrew is
  unaffected because CLI binaries do not go through LaunchServices. Not worth
  working around -- a notarized Developer ID build is the answer, if IT's policy
  is the standard one rather than an allowlist. **Confirmed 2026-09-13**: the
  first notarized build installed and ran there with no argument, so the policy
  was the standard one and notarization was the whole of it.

### 2026-09-06, later: the file player

Everything in *The file player* was new here and unheard at the time. All of it
has since been confirmed in the app (see *Verification*). The
position arithmetic and the resampler are simulation- and unit-checked (run,
then deleted): mono folds to stereo at the same length, a matching rate is a
byte-exact copy, 44.1k resamples to 48k at the same duration, empty and
zero-channel files don't panic, a whole cycle of `fileShift` is a no-op, and the
derived position holds within one frame over ten minutes where the old
accumulating one is 4505 frames out.

What that does *not* establish: that a Logic bounce lands where you expect
against the click, that `fileOffsetMs` has the sign that feels right at the
keyboard, that `set tempo from file` gives a tempo you'd have typed, or that the
file bus is legible in a pane next to your own playing. The mono and rate
conversions also now sit under the *drum* samples, which were fine before and
should be listened to once for that reason.

A-B repeat and the time stretching were newer still and equally unheard here;
both have since been confirmed. The
stretch is unit-checked for pitch (a sine holds within 0.5 Hz from 0.5x to 2x),
for amplitude across the loop seam, for length, for degenerate ratios and for
cost; what no test can say is whether a real drum loop at 0.85x sounds like
something you'd want to play along with.

Still to build, and deliberately not started: selecting a *region* of the file
rather than using all of it, and the static waveform with hand-drawn beat
markers. The static waveform is v2 by decision -- a long file is the open
question there, and per-pixel peaks of a whole one is the wrong first answer.

### 2026-09-07: random parameters, and expressions in drum gains

`choose` / `range`, the per-row 🎲 and reroll-all are new. **⌘R is confirmed
working in the bundle.** Covered by temp tests (run, then deleted): `choose` only
ever returns one of its arguments and doesn't fall off the end at an rng of
exactly 1, `range` stays inside its ends, a roll reads the other parameters,
resolving fifty times in a row does not re-roll, a dependant follows every
reroll, rerolling one leaves the others untouched, a list roll repeats like a
list, a half-typed roll keeps its stored value but fails the editor's check, and
a cycle through a roll is still reported as a cycle.

Open questions are about taste rather than correctness: whether the roll being
sticky across a session restore is what you want in practice or whether you'd
rather it rolled fresh at launch, and whether `1, g x k` with a rolled `g` is a
musically useful thing to have or just a noisy one.

The **practice cycle** (see its own section) is new and unheard. Checked by temp
test in Rust (run, then deleted): the bounds run and total correctly, a skipped
or zero-length section is left out without stalling the cycle, the reused vector
never regrows, every beat belongs to exactly one section, a sounding beat past
the wrap or before zero reduces into the cycle, an empty cycle answers nothing
rather than panicking, and -- replaying the callback's own gating over two full
cycles -- the click covers exactly the count-off, the drums cover exactly the
groove and never bleed into the count-off or the pause, and the groove's own
downbeat is not lost to the offset look-ahead. On the frontend (also deleted): a
section length re-resolves on a parameter change and keeps its last good value
and text when it stops evaluating, a zero or negative length is refused, and a
session that had `clickToggle` on comes back as the equivalent two sections
while one that had it off gains none.

What no test can say: whether the reroll landing a few milliseconds into the
cycle is audible at the top of a count-off, and whether the whole thing is
actually a good way to practise.

`show` and `sectionOrder` followed the same day, the second because the
"no repeat count" argument above was only true of a *single* section. Also
temp-tested (run, then deleted): the drawn timeline starts where the playing
does and a count-off stamps nothing, a hidden section in the middle leaves a gap
rather than closing up, a hidden last section swallows the negative stamps after
a restart, a group repeat alternates rather than lengthening, the repeat count
can be a parameter, groups nest, an index past the end wraps, a section left out
of the order simply does not play, and an order against no sections answers
nothing rather than panicking.

Drum `gains` became expression-backed in the same pass. Checked by temp test
(run, then deleted): a pre-expression bare array still reads and is wrapped on
the way through the resolve walk, an expression re-resolves on every parameter
change, a list parameter stands where a group would, a parameter going away
keeps the last good gains *and* the typed text, absent gains stay absent and
read as unity, an empty list can never be committed, and the rhythm beside it is
untouched.

`rowColorPattern` / `rowColorPatternDown` took expressions in the same pass and
by the same two steps. Temp-tested (run, then deleted): a pre-expression bare
array still colours and is wrapped by the walk, `1, 2x(n-1)` follows `n` in both
directions, the down pattern resolves independently of the upper one, an empty
down pattern still means the halves agree, an empty pattern still paints every
row the first colour, no colours still falls back to the channel's, a vanished
parameter keeps the last good pattern *and* the text, and an index past the
palette still wraps.

Also this day: `subdivisionOffset` deleted (it had a UI input and the draw code
had never read it), every parameter now showing what it resolves to rather than
only the randoms, `range` taking an optional step, and `yarn tauri` going
through `scripts/tauri.mjs` so a successful build sweeps stale disk images, the
sweep eraser covering the pixel rows a loud bar antialiases into, and the
`clickToggle` gate moving to the beat a drum hit sounds on -- which was then
generalised away entirely by the practice cycle, below.

The **high pass** (see its own section) is new and unheard and unseen. Checked
by temp test in Rust (run, then deleted): the passband is flat within 0.25 dB,
the labelled cutoff really is the 3 dB point at 200/800/3000 Hz, the asymptotic
slope is 12 dB/octave, DC is gone entirely, a nonsense cutoff passes the signal
rather than silencing it and produces no NaN, a cutoff past Nyquist removes
everything without blowing up, and filtering the summed echoes matches filtering
before storage to within 1e-4. What no test can say is whether 800 Hz is a
useful default, or whether the filtered picture is easier to play against than
the raw one.

### 2026-09-12: signing and notarization

The app and the disk image are both signed with a Developer ID, notarized and
stapled, and `yarn tauri build` does the whole chain unattended. See *Signing
and notarization* for the mechanics and *The disk image step* for the two ways
it fails.

Verified mechanically on the build machine: the signature chains to the Apple
Root CA with a secure timestamp, `codesign -dv` reports `flags=0x10000(runtime)`
rather than the old `adhoc,runtime`, `TeamIdentifier` is set, `spctl -a` answers
`accepted` with `source=Notarized Developer ID` for both artifacts, and both
staples validate. Notarization returned `Accepted` on every submission.

**Confirmed on the managed work Mac, 2026-09-13** -- installed and ran, where no
previous build could be launched at all. That is the strongest single result
here, because it is the one machine whose refusal was enforced by policy rather
than talked round.

**The signature is stable enough to carry a TCC grant across a whole new build**
-- confirmed the same day by the updater round trip, where v0.2.0 became v0.2.1
in place and the microphone kept working with no new prompt. That was the point
of paying for the certificate, and it is now a fact rather than an expectation.
See *Updates*.

## Discussed but not built

- **An iOS / iPadOS port.** Wanted eventually, iPad first. Doable, and the code
  is already split roughly the right way: `analysis.rs`, `calibration.rs`,
  `structs.rs`, `read_audio_file.rs`, `util.rs`, `prefs.rs` and
  `get_loop_buffer_size.rs` -- about 1500 lines, including the beat clock, the
  FFT, the flux, the onset picker and the matched filter -- are pure logic and
  port unchanged. The damage is concentrated in `io_channels.rs` (428 lines, 31
  Core Audio calls) and the setup half of `main.rs`. Two blockers and three
  consequences:
  - **Tauri v1 has no mobile support.** A v2 migration comes first: allowlist to
    the capabilities model, `tauri::api::path` into plugins, a new config
    schema. Mechanical but wide -- every command and the whole config file.
  - **iOS has no Core Audio HAL.** `AudioObjectGetPropertyData`, `AudioDeviceID`,
    device enumeration, `kAudioDevicePropertyNominalSampleRate` are all
    macOS-only. iOS uses AVAudioSession, which is a different *model*, not a
    different spelling: you declare a category and a *preferred* rate, and the
    system routes and decides. Audio itself is a RemoteIO unit rather than AUHAL.
    `coreaudio-rs`'s `macos_helpers` is exactly what its name says.
  - **The device picker becomes meaningless**, not merely unported -- routing is
    the user's business on iOS.
  - **The calibration becomes optional but stays useful.** iOS reports
    `inputLatency` / `outputLatency` / `ioBufferDuration` directly. Keep the
    measurement anyway: it reads the real round trip including the air path,
    which those figures cannot know.
  - **Decimated sample transport stops being optional.** `get_samples` returns
    JSON over IPC 100x a second, which is comfortable on a Mac and not on a
    phone.
  - Phone-specific and *not* just design: AVAudioSession interruptions (calls,
    alarms, another app taking the session) have to be handled and the unit
    restarted -- there is no macOS equivalent in the code today. And Bluetooth
    output is ~150-200 ms, which the calibration would measure honestly and
    absorb correctly while still being unplayable -- not because 200 ms is
    large, which `buffer_compensation` handles fine, but because it *varies*
    with codec renegotiation and interference, and a compensation can only
    absorb a constant. Wired or built-in only.
  - An Apple Developer Program membership stops being optional: iOS has no
    ad-hoc sideloading escape hatch. **No longer a blocker** -- the membership
    and a Developer ID exist as of 2026-09-12, though iOS needs its own
    distribution certificate and provisioning profile on top of it.

- **Staying in sync with a loop playing in Logic**, so you can watch your
  playing against a part Logic is looping *live* rather than a bounce of it.
  - **The clock is not the problem; the phase is.** On one audio device Logic's
    playback and this app's `beat` come off the same crystal, so a tempo typed
    in exactly never drifts from Logic's. All that is missing is where bar 1
    fell, once. On separate devices the drift is back and the answer is an
    Aggregate Device, as it is for multiple inputs.
  - **Bouncing the loop and using the file player already solves this exactly**,
    by construction -- `fileBeats` phase-locks it, A-B repeat picks the segment,
    the stretch follows the tempo. Sync only matters when Logic has to stay
    live: muting parts, editing the arrangement while you play.
  - **MIDI clock over the IAC Driver is the first thing to try** (owner's call).
    Logic transmits it from Project Settings -> Synchronization -> MIDI; read it
    in Rust with `midir` or `coremidi`. 24 ppqn, and Start / Song Position
    Pointer are what carry the phase. Its jitter is the usual complaint and does
    not matter here, since it is only ever used to set phase -- and can be
    averaged over several loop passes.
  - **A tiny AU that broadcasts the host's transport** is the solid version: it
    reads tempo, beat and playing state per render block and sends them to the
    app over a local socket. Sample-accurate, and the app keeps its own device
    and its own clock. Costs a second build target and its signing.
  - **A sync tone through the mic** would reuse `calibration.rs`'s matched
    filter and arrive by the same path as your playing, so the latency is one
    already measured. Acoustically fragile; noted for completeness.
  - **Ableton Link is the right protocol and Logic does not support it.**
    Reachable only through a bridge app. ReWire is dead -- removed in Logic 10.5.
  - **Whatever carries the phase needs a trim**, because "bar 1" means when
    Logic's audio *sounds*, not when its transport says zero. One number, the
    same shape as `pairCompensations`, measurable by the round trip already
    built.

- **Building the whole thing as an Audio Unit**, loadable in Logic and
  GarageBand. Bigger than the sync question and it subsumes it -- a plugin gets
  tempo and phase from the host for free.
  - **It deletes the code blocking the iPad port.** The host owns the device, so
    device enumeration, the sample-rate negotiation, the picker and
    `audio-prefs.json` all stop existing, and `io_channels.rs` largely goes with
    them. That is the same 428 lines the iOS entry above names as the damage,
    and the same reason iOS was hard: an AUv3 is one target on both platforms.
    "Plugin for Logic" and "app for iPad" are substantially one project.
  - **AUv3, not AUv2** -- both hosts take it, and it is the only path to iPad.
  - **What the plugin keeps is the display and the looper.** The click and the
    drum parts are the two things Logic genuinely covers better. The looper is
    *not*: Delay Designer works in units of time with an awkward UI and a 10
    second ceiling, where this one is beat-locked and runs to ten minutes.
  - **The UI is the hard part, by a distance.** Either host a `WKWebView` in the
    `AUViewController` and keep the React panel and the whole canvas draw path
    -- rebuilding the transport, since `invoke`/`get_samples` becomes
    `WKScriptMessageHandler` and `evaluateJavaScript`, and 100 Hz JSON really
    would want the decimated peaks first -- or rewrite the panel in SwiftUI,
    which is much larger.
  - **Rust has no first-class AU story.** `nih-plug` covers CLAP and VST3 and is
    weakest exactly here. The pragmatic shape is a Swift `AUAudioUnit` subclass
    over a Rust staticlib, which is what the pure-logic modules are already
    shaped for.
  - **Anything process-global breaks**, because a plugin is instantiated many
    times per session. `sample_rate()`'s `OnceLock` in `constants.rs` is that
    bug already written down and waiting. An audit, not a redesign, but it
    precedes everything.
  - **Sandboxing changes file loading.** An app extension cannot open a path;
    the container app has to hand over a security-scoped bookmark, which the
    file player and the drum samples both go through.
  - **The host picks the buffer size**, possibly 32 frames rather than 2048.
    Everything documented as "once per callback" then happens 64x as often --
    all of it cheap, none of it confirmed.
  - **What gets easier:** `buffer_compensation` and most of the calibration
    evaporate, since the host positions the audio on its own timeline and
    latency is declared through a property; and AU state saves *with the Logic
    project*, which beats localStorage.
  - **The shape is a second front-end over a shared Rust core**, not a port --
    the ~1500 pure lines the iOS entry lists, plus whatever display logic can be
    pushed down out of `App.tsx`.

- **Per-channel latency offsets.** Wanted, low priority — the owner isn't
  worried about a few ms of mic distance.
- **Multiple input devices.** Do *not* build offset correction for this. Latency
  correction fixes the constant offset but not clock drift between independent
  crystals (~0.2 ms/s worst case, so ~1 ms of misalignment within seconds). The
  answer is a macOS Aggregate Device, which resamples onto one clock; then
  "several interfaces" is the same code path as "one device with more channels".
  v1 = user creates it in Audio MIDI Setup; v2 = app creates it via
  `AudioHardwareCreateAggregateDevice`.
- **A static file waveform, and hand-drawn beat markers.** The next step for
  playing along with a file: per-pixel peaks painted under the grid, stable
  rather than swept, as the surface you click on to say where the beats are.
  Deferred on the question of what a long file costs -- peaks for a whole file
  at pane resolution is fine for a two-bar loop and not for an album side, so it
  wants a region and probably a decimation step before it wants drawing code.
  The onset picker could *propose* markers once they exist, but manual ones come
  first: they're the ground truth any detector would be checked against, and the
  point of the tool is that it's authoritative.
- **Cancelling the app's own output out of the sound, properly.** The switch
  exists (`bleedCancelAudioOn`, see *Out of the looper*) and is enough to move
  the looper's feedback threshold by about a factor of two. What it is not is
  *clean*: a bar 20 dB down is invisible, a click 20 dB down is still audible in
  a quiet passage, and the residual has a spectrum rather than only a level.
  - **Everything past the linear filter costs transients.** Real echo
    cancellers get their last 20 dB from a nonlinear residual suppressor, which
    is spectral gating, which smears exactly what this app exists to let you
    place. The same objection that ruled out a phase vocoder for the stretch.
  - **A second reference would be the honest fix for panned material**, since
    two speakers emitting different signals are two paths and one probe
    measured their sum. Stereo echo cancellation is genuinely hard -- with
    correlated references the solution is not unique -- and it buys nothing for
    the click and drums, which are emitted mono.
  - **It would want the filter persisted first**, because recording a take
    through a filter measured for a different volume is a quieter kind of wrong
    than drawing one.
  - Headphones remain the answer for the sound.
- **The preset thread, in the order it should be done** (2026-09-13). The three
  entries below are one line of work, not three independent ideas: **kits
  first**, because they make a shared preset clean by construction and change
  what the other two mean; then **partial loading**, which is wanted soon and
  reuses `PresetDialog`; then **bundling audio**, which may largely evaporate
  once kits exist -- decide it afterwards rather than before.
- **Interchangeable drum kits.** A voice would name a *role* (`kick`) and a
  machine-local kit would map roles to files -- the same split the config,
  `audio-prefs.json` and `LOCAL_RUST_KEYS` already make three times over. It
  removes the drum half of the shared-preset path problem entirely rather than
  reporting on it (see *Presets, and the second file store*), and it is the
  missing half of something already half-built: parser2 parses sound letters
  per note and nothing reads them, so roles are what would let one rhythm drive
  several voices. `sound?` goes *alongside* `path`, never replacing it -- the
  `#[serde(default)]` treatment `shift` and `gains` already have. The part that
  would actually hold this up is shipping a default kit, which is an asset and
  licensing question rather than a code one; `BUILT_IN_DRUMS` is one sound
  today.
- **Bundling the referenced audio with an exported preset.** Deliberately
  waiting for kits, because kits change what it means: once drums resolve
  through a kit there are no drum references left in a preset, and the only
  thing left to bundle is the backing track -- the one file that is big,
  personal, often not yours to pass on, and least appropriate to put in
  something you hand to someone. If it is built anyway it needs a container
  rather than one JSON, relative references inside it, and imported media
  copied into an app-managed folder, since a bundle opened from Downloads may
  not be there tomorrow. That is a fourth store.
- **Loading only part of a preset** -- the drums, or the visuals. Wanted soon.
  **Parts are a load-time filter, never a storage shape**: if "export just the
  drums" became saveable there would be two kinds of preset file and import
  would have to handle both. The file stays whole and `PresetDialog` gains a
  second column, which is why it takes its rows and actions rather than knowing
  what it is listing.
- **Recording a session to a file.** WAV only: a header is 44 bytes and
  symphonia is already in the tree for the other direction, where MP3 means an
  encoder dependency and a licensing conversation to save a file you would
  convert anyway. The constraint that shapes it is the usual one -- **nothing
  touches the disk on the audio thread.** The callback pushes into a ring and a
  writer thread drains it, the same shape `stretch.rs` uses for the off-thread
  render and `get_samples` uses for the pre-sized swap. Streaming rather than a
  memory buffer, since a practice session is long. Worth deciding up front
  *what* is recorded: the input alone, or the output mix -- both are already
  sitting in the callback as `input_audio` and the summed channel, so it is a
  choice rather than work.

- **A reference loop: capture a phrase once, then play it back for ever.**
  Armed with a count-in or starting at the next cycle, drawable like any bus,
  cleared with a button.
  - **This is the file player, not the looper.** The looper is a multi-tap
    delay with a fixed number of echoes; what this wants is a buffer
    phase-locked to the beat, which is exactly what `fileBeats` does -- the
    position derived from `beat` and never accumulated. Building it on the file
    player's arithmetic gets A-B repeat, `fileShift`, the varispeed and the
    drawing bus for nothing, where building it on the looper gets none of them.
  - Arming at the next cycle boundary is `section_bounds`, which already exists.

- **Loop recording cycles**: record for 16 beats, play back for 16 and do not
  record, configured as a list (`[32,16,16,16]` = silent 32, recording 16, …)
  or a bare number that just toggles at that length.
  - **This is the alternating record/playback that was already named as the
    real fix for looper feedback** (see *Out of the looper*), so it closes that
    thread rather than only adding a feature. It gives up continuous recording,
    which is what makes overlapping phrases work -- the trade that entry
    describes.
  - **It should almost certainly be a field on `Section`, not a second cycle.**
    Sections are already "for this many beats, these sound", they already take
    a list, and `sectionOrder` already does groups and repeats through
    `parseNumberList`. Two independent cycle mechanisms both gating the looper
    is precisely the tangle `clickToggle` was retired to avoid.
  - **The one real question is whether it wants to be independent of the
    practice cycle**, since a section wrap also restarts the beat, rerolls the
    parameters and clears the looper. If a record/play cycle has to run *across*
    those, it cannot be a section -- and that is the thing to settle before
    building either version.

- **Tools for working with panes** -- **built 2026-09-14**, bar the drag UI.
  Remove, add, grow, swap, copy from another pane and reset are all buttons in
  the display tab's pane map; names were done earlier. See *Pane placement* and
  `docs/pane-layout.md`.
  - **What is left is the drag UI**, and arbitrary (non-grid) layouts, which
    want the recursive split tree that document rejects. The drag UI needs
    nothing about the schema to change.

- **A binding editor.** One global key exists now (see *The global shortcut*);
  what is not built is a second action, a recorded-keystroke picker instead of
  a typed accelerator, or a list. All three want the same store and the same
  registration path, so they are additions rather than a redesign.

- **Rendering a drum part to a file offline**, non-realtime, for a set length.
  - **The work is extracting the drum logic out of the render closure**, which
    owns everything by value and cannot be called for a fake output. That is
    the same extraction the AU and iPad ports need -- see those entries, where
    the ~1500 pure lines are what makes them plausible -- so this is a down
    payment rather than a detour. It also shares a WAV writer with recording a
    session.

- **A grid UI for drum parts**: sounds down the y axis, beats across, the beat
  count anything you like, and the underlying pulse a number *or an array* --
  `[.3,.2]` for swing, `[.3,.3,.2,.2]` for a Dilla feel -- with several running
  at once against each other for polymeter.
  - **The pulse-as-a-list is the same abstraction *One row per note* already
    uses**, and the polymeter case is several drum voices with different
    rhythms, which already works. The new part is the editing surface.
  - **It needs named drum sounds first**: "sounds on the y axis" *is* roles, so
    it sits behind the kit entry above.
  - **The builder writes rhythm text and never becomes a second format** --
    already the stated rule for the pattern builder in
    `docs/approachability.md`, and the same rule applies here.

- **Per-hit probability on a drum rhythm**, beyond the implicit 0 and 1.
  - **Do not reach for `choose` / `range` here.** A roll is deliberately
    *sticky* -- its stored value **is** its value, and the whole config is
    re-resolved on every keystroke, so a live roll in a field would mean no
    number in the app ever holds still (see *Parameters and expressions*).
    Making them evaluate per hit would contradict that directly.
  - **What it actually wants is `gains` with a coin flip.** A `chances` list
    beside it, same `parseNumberList` "1,0.5x3" syntax, indexed by *hit count*
    with `rem_euclid` so a length that does not divide the rhythm drifts rather
    than resetting -- which is the point there and would be the point here.
    `rng` is already on the audio thread for the click and the bleed probe, and
    one comparison per trigger allocates nothing.
  - The roll happens at the trigger, which is `offset_beats` early. That is
    still exactly once per hit, so it is fine -- and a hit that does not sound
    simply is not drawn, since the drums bus carries what actually played.

- **Decimated sample transport.** Send per-block peaks from Rust instead of raw
  samples. The frontend already reduces to per-pixel peaks, so the picture is
  identical for ~8× less JSON. Worth doing before going past a few channels.
- **Onset detection for pitched instruments.** The picker in *Onsets* is built
  and drawing; what it does not do is hear a new note on one string while
  another sustains, which needs more frequency-domain work than a single flux
  curve. The amplitude envelope stays worth drawing either way -- it is what
  says something about sustain and volume.
- Per-channel loop buffers exist now, but per-channel *input gain* does not.

## Conventions

- Comments explain *why*, not what. Match the surrounding density.
- Temp test files: write `src/Foo.tmp.test.tsx`, run
  `CI=true npx react-scripts test --testPathPattern Foo.tmp`, then delete. The
  repo intentionally has no committed test suite.
- `user-event` is v13 — no `userEvent.setup()`, and `[` / `{` are special
  characters in `.type()`.
- jsdom has no `PointerEvent` or pointer capture; stub them for drag tests.
