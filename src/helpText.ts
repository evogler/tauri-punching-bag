// Every description the help area shows, in one place so the whole voice can
// be read and edited together. Keyed by config key where the control has one --
// `Input` looks its own key up, so a field gains help just by appearing here --
// and by a dotted id otherwise. Backticks mark something you would type.
//
// What each entry tries to say: what it does, why you would change it, its
// units, and an example where it takes syntax.

export type HelpEntry = { title: string; body: string };

export const HELP: Record<string, HelpEntry> = {
  // ---- pinned ----
  paused: {
    title: "Pause (⌘P)",
    body: "Freezes the beat, the click, the drums, the file and the display. Resume carries on from where it stopped.",
  },
  restart: {
    title: "Restart from beat 1",
    body: "Puts the beat back to 1 now, so the click, the drums, the file and the display cursor all start the bar again together.",
  },
  bpm: {
    title: "Tempo (bpm)",
    body: "Beats per minute. Everything follows it: the click, the drums, the loop length, the file's stretch. Takes arithmetic and parameters, e.g. `t*2`.",
  },
  loopingOn: {
    title: "Looper (⌘L)",
    body: "Plays back what you played, a loop length later -- set the length and the echoes in the Loop tab. Recording never stops, so phrases can overlap.",
  },
  helpToggle: {
    title: "Help",
    body: "Shows or hides this area. Remembered on this machine.",
  },

  "presets.list": {
    title: "Presets",
    body: "Settings you have saved. Your latency and whether you are paused are never part of a preset, since they belong to this machine and this moment.",
  },
  "presets.sort": {
    title: "Sort",
    body: "Order the list by name, by when each was saved, or by when each was last loaded.",
  },
  "presets.load": {
    title: "Load",
    body: "Replaces every setting with the preset's. Anything the preset doesn't mention goes back to its default, so loading one never leaves a mix of two.",
  },
  "presets.delete": { title: "Delete", body: "Deletes the chosen preset. Asks first." },
  "presets.name": {
    title: "Preset name",
    body: "What to call the current settings when you save them. Enter saves.",
  },
  "presets.save": {
    title: "Save",
    body: "Saves the current settings under the name beside it. Saving over an existing name asks first.",
  },
  "presets.defaults": {
    title: "Reset to defaults",
    body: "Puts every setting back to how the app starts. Your latency is kept.",
  },
  "presets.import": {
    title: "Import…",
    body: "Adds presets from a file someone gave you. You see what each one will do -- new, an update, a duplicate -- before anything is saved.",
  },
  "presets.manage": {
    title: "Manage…",
    body: "Export several presets to a file to share, or delete several at once.",
  },

  parameters: {
    title: "Parameters",
    body: "Named numbers any field can use. With `n = 16` and `bar = 4`, a pane's rows can read `bar/n x n` and a grid `{n/bar}:1`, so switching to 16ths is one edit instead of five.",
  },
  "parameters.name": {
    title: "Name",
    body: "What to write in other fields. Letters, digits and underscore. Taken: `x`, `min`, `max`, `round`, `choose`, `range`, and the sound letters `h` `k` `r` `s`.",
  },
  "parameters.value": {
    title: "Value",
    body: "A number, a list like `.6,.4`, arithmetic over other parameters like `bar*4`, or a roll: `choose(1,2,3)` picks one, `range(80,120)` picks between, `range(80,120,5)` picks in steps. A roll holds still until you reroll it.",
  },
  "parameters.reroll": {
    title: "Reroll",
    body: "Draws a new value for this random parameter. Everything that uses it follows.",
  },
  "parameters.rerollAll": {
    title: "Reroll all (⌘R)",
    body: "Draws new values for every random parameter at once. The practice cycle also does this each time it starts over.",
  },
  "parameters.add": {
    title: "Add parameter",
    body: "Adds a named number. Rename it, then use the name in any field that takes arithmetic, or bare in a rhythm.",
  },

  // ---- play ----
  clickOn: { title: "Click", body: "Turns the metronome click on or off." },
  audioSubdivisions: {
    title: "Rhythm",
    body: "When the click sounds. `1` is every beat, `2:1` twice a beat, `3:4` three evenly across four beats, `[2:1, 1]:1` a group squeezed into one beat. Parameters work bare: `n:1`.",
  },
  clickVolume: { title: "Volume", body: "How loud the click is. 1 is normal." },
  clickShift: {
    title: "Shift (beats)",
    body: "Moves the click later by this many beats. `0.5` puts it on the offbeat. Musical placement, so it follows the tempo.",
  },

  drumOn: {
    title: "Drums",
    body: "Turns every drum part on or off together. Each part below also has its own switch.",
  },
  "drums.on": { title: "On", body: "Mutes or unmutes this one part." },
  "drums.sound": {
    title: "Sound",
    body: "The sample this part plays. The built-in kit -- kick, snare, hi-hat, ride -- is listed by name and works on any machine; a file you added shows its file name. Red means the file couldn't be found.",
  },
  "drums.rhythm": {
    title: "Rhythm",
    body: "When this part plays, in the same notation as the click: `1`, `2:1`, `[k 1, h 1]x4:1`. Parameters work bare.",
  },
  "drums.accents": {
    title: "Accents",
    body: "A volume for each hit in turn, cycling: `1, 0.5` alternates loud and soft, `1, 0.6x3` accents every fourth. A list whose length doesn't fit the rhythm drifts across the bar on purpose. Multiplies the volume slider.",
  },
  "drums.chances": {
    title: "Chance",
    body: "How likely each hit in turn is to sound, cycling the same way accents do: `1, 0.5` drops every other hit half the time, `0.8` thins the whole part. Empty means every hit sounds. A hit that doesn't sound still keeps its place, so this and the accents stay in step.",
  },
  "drums.shift": {
    title: "Shift (beats)",
    body: "Moves this part later by this many beats, so it doesn't have to start on one. Follows the tempo.",
  },
  "drums.offset": {
    title: "Offset (ms)",
    body: "Starts the sample this many milliseconds early, so a sample whose attack comes a little way in still lands on the beat. Mechanical alignment, independent of tempo.",
  },
  "drums.volume": { title: "Volume", body: "This part's volume, up to double." },
  "drums.add": {
    title: "Add sound…",
    body: "Adds a drum part: a sound from the built-in kit, or any audio file. Kit sounds travel with a preset to someone else's machine; a file only does if they have the same file in the same place.",
  },

  sectionsOn: {
    title: "Run the cycle",
    body: "Plays the sections below in order, then starts over: every random parameter rerolled, the beat back to 1, the looper cleared. Off, everything sounds continuously.",
  },
  "sections.on": {
    title: "Use this section",
    body: "Off leaves the section out of the cycle without deleting it.",
  },
  "sections.number": {
    title: "Section number",
    body: "How the Order field refers to this section.",
  },
  "sections.beats": {
    title: "Beats",
    body: "How long this section lasts. Arithmetic and parameters work: `bar*16`. There is no repeat count -- longer is the same as repeated.",
  },
  "sections.click": { title: "Click", body: "Whether the click sounds during this section." },
  "sections.show": {
    title: "Show",
    body: "Whether this stretch is drawn. Off, the cursor holds still through it -- a count-off with Show off means the groove starts at the top of the pane.",
  },
  "sections.drums": {
    title: "What sounds",
    body: "Which drum parts play in this section. Lit ones play. A count-off is usually a section with one part on.",
  },
  sectionOrder: {
    title: "Order",
    body: "Which sections play, by number, and how often. `1, [2,3]x8` is section 1 then eight passes of 2 and 3. Empty plays them in the order listed.",
  },
  "sections.add": { title: "Add section", body: "Adds a stretch to the cycle, with every drum part on." },

  // ---- file ----
  filePath: {
    title: "Choose file…",
    body: "An audio file to play along with -- a bounce from your DAW, a song, a loop. It repeats, and stays in time with the beat once you give it a length.",
  },
  playFile: { title: "Play", body: "Plays or silences the file." },
  fileVolume: { title: "Volume", body: "How loud the file is. 1 is as recorded." },
  fileBeats: {
    title: "Length (beats)",
    body: "How many beats long the file is. This is what locks it to the beat so it never drifts. 0 plays it at its own speed, not locked to anything.",
  },
  setTempoFromFile: {
    title: "Set tempo from file",
    body: "Sets the tempo so the file lasts exactly Length beats -- the tempo it was recorded at.",
  },
  fileShift: {
    title: "Shift (beats)",
    body: "Moves the file later by this many beats against the grid. Follows the tempo.",
  },
  fileOffsetMs: {
    title: "Offset (ms)",
    body: "Starts the file this many milliseconds early, for a bounce whose first downbeat sits a little way in.",
  },
  fileStretch: {
    title: "Stretch to tempo",
    body: "Speeds the file up or slows it down to fit Length at the current tempo, without changing its pitch. Clean to about a third either way; past that the readout turns orange.",
  },
  fileRepeatOn: {
    title: "Repeat A–B",
    body: "Loops just part of the file instead of the whole thing. Needs a Length.",
  },
  fileRepeatStart: {
    title: "From beat",
    body: "Where the repeated part starts, in the file's own beats. It may run past the end and wrap to the start, which is how you loop a pickup.",
  },
  fileRepeatEnd: { title: "To beat", body: "Where the repeated part ends, in the file's own beats." },

  // ---- loop ----
  beatsToLoop: {
    title: "Loop length (beats)",
    body: "How far back each echo reaches. At 4, what you play comes back four beats later.",
  },
  loopEchoes: {
    title: "Echoes",
    body: "How many times a phrase comes back before it's gone, 1 to 16.",
  },
  loopEchoGain: {
    title: "Echo volume",
    body: "The volume of each echo relative to the one before. 1 keeps every echo full volume; 0.5 halves each time; 0 silences everything after the first.",
  },
  audioMonitorOn: {
    title: "Hear live input",
    body: "Plays what the microphone hears through the output as you play. Useful on headphones; on speakers it can feed back.",
  },
  visualMonitorOn: {
    title: "Draw live input",
    body: "Draws what you are playing right now. Off, only the loop's echoes are drawn, which shows how the last pass sat against the grid.",
  },
  bleedCancelAudioOn: {
    title: "Keep the app's sound out of the loop",
    body: "On speakers, subtracts the click, drums, file and echoes from what the looper records and what you hear back, which stops the loop feeding on itself. Needs speaker bleed measured in the Setup tab first.",
  },
  loopFeedbackGuardOn: {
    title: "Stop feedback runaway",
    body: "Holds down any frequency that keeps getting louder each time round the loop. For speakers, where what survives cancelling is usually one narrow band that grows over minutes. It will also fight a part you are deliberately building up.",
  },

  // ---- display ----
  arrangement: {
    title: "Arrangement",
    body: "How many panes, across and down. A new pane starts as a copy of pane 1, so you can watch the same playing against a different grid.",
  },
  viewsSequential: {
    title: "Run panes in sequence",
    body: "Off, every pane shows the same beats, each against its own ruling. On, the panes share one long timeline: the playing runs through pane 1's rows, then pane 2's.",
  },
  panes: { title: "Pane", body: "Which pane the settings below edit." },
  channels: {
    title: "Channels",
    body: "What this pane draws: your inputs, and the drums, click and file as the app plays them. The dot is the channel's color, set in the Setup tab.",
  },
  kind: {
    title: "Display",
    body: "Waveform draws loudness, the usual picture. Spectrogram draws which frequencies are sounding, brighter for louder -- inputs only.",
  },
  spectrogramChannel: { title: "Spectrum of", body: "Which input this spectrogram shows." },
  spectrogramGain: { title: "Brightness", body: "How bright the spectrogram draws." },
  spectrogramFloor: {
    title: "Floor",
    body: "Anything quieter than this draws as background. Raise it to clear away hiss.",
  },
  rowPerNote: {
    title: "One row per note…",
    body: "Sets this pane up for placing one note at a time: a row per note, the note a quarter of the way in, a green line where it belongs and a red one exactly between notes. Replaces the pane's rows, lead-in and grids. Writes expressions, so it follows your parameters.",
  },
  "rowPerNote.division": {
    title: "Division",
    body: "How long one note is, in beats: `1/4` for 16ths against a quarter-note beat, `bar/n`, or a swing pair like `.6,.4`.",
  },
  "rowPerNote.count": { title: "How many", body: "How many notes to show, one per row." },
  "rowPerNote.lead": {
    title: "Lead-in",
    body: "How far into the row the note sits, as a fraction of one note: `1/4` puts it a quarter of the way across.",
  },
  beatsPerRow: {
    title: "Beats per row",
    body: "How many beats each row spans, as a list, one entry per row. `0.25x16` is sixteen rows of a quarter beat; `bar/n x n` follows your parameters; `[.6,.4]x8` alternates.",
  },
  marginLeft: {
    title: "Lead-in (beats)",
    body: "Extra beats drawn, dimmer, before each row's own beats -- so a note played a little early still shows at the start of its row.",
  },
  marginRight: {
    title: "Lead-out (beats)",
    body: "Extra beats drawn, dimmer, after each row's own beats -- so a note played a little late still shows at the end of its row.",
  },
  visualGain: {
    title: "Waveform size",
    body: "How tall the waveform draws. Only the picture -- the sound is unchanged. Per-channel levels are in the Setup tab.",
  },
  splitChannels: {
    title: "Split channels top/bottom",
    body: "Draws the first half of this pane's channels upward and the rest downward in each row, so two inputs can share a row without covering each other.",
  },
  barColorMode: {
    title: "Color by loudness",
    body: "Shades the whole row by how loud it is instead of drawing the waveform shape. Overrides row colors.",
  },
  refreshAtCycleEnd: {
    title: "Redraw once per pass",
    body: "Off, the picture is redrawn column by column as the cursor sweeps. On, a whole pass is collected and drawn at once when it wraps.",
  },
  showFlux: {
    title: "Show attack strength",
    body: "Draws a curve of how sharply the sound is getting brighter. It spikes where notes start, which makes attacks easy to see inside a sustained sound.",
  },
  fluxGain: { title: "Attack strength size", body: "How tall the attack strength curve draws." },
  showOnsets: {
    title: "Show note starts",
    body: "Marks each detected note start with a tick at the edge of the row. Tune the detection in the Analysis tab.",
  },
  rowColors: {
    title: "Row colors",
    body: "Colors the rows can take, numbered. With none, rows use each channel's own color. Use Row color pattern to say which row takes which.",
  },
  rowColorPattern: {
    title: "Row color pattern",
    body: "Which color each row takes, by number, cycling: `1, 2x3` colors every fourth row with color 1 -- the rows that start a beat at `0.25x16`. `1, 2x(n-1)` follows a parameter.",
  },
  rowColorPatternDown: {
    title: "Row color pattern (bottom)",
    body: "The same, for the lower half when channels are split. Read from the same colors, so the halves can differ and still both mark the beat.",
  },
  "grids.drag": { title: "Reorder", body: "Drag to reorder. The top of the list draws on top." },
  "grids.color": { title: "Grid color", body: "The color of this grid's lines." },
  "grids.rhythm": {
    title: "Grid rhythm",
    body: "Where the lines fall, in the same notation as the click: `1:1` every beat, `4:1` four per beat, `n:1` from a parameter.",
  },
  "grids.shift": {
    title: "Shift (beats)",
    body: "Moves this grid later by this many beats. `1/3` or `bar/n` work.",
  },
  "grids.opacity": { title: "Opacity", body: "How strong this grid's lines draw." },
  "grids.add": { title: "Add grid", body: "Adds another set of lines, in a color not already used." },

  // ---- layout ----
  waveformBackground: { title: "Background", body: "The color every pane is drawn on." },
  gridWidth: {
    title: "Grid line width",
    body: "How thick grid lines draw, the same on any screen. 0.5 is the thinnest a Retina display can show.",
  },
  paneGap: {
    title: "Gap",
    body: "Space between panes, in pixels. Needs more than one pane to see.",
  },
  paneGapColor: { title: "Gap color", body: "The color showing through the gap between panes." },

  // ---- setup ----
  "device.input": {
    title: "Input",
    body: "The microphone or interface to listen to. Takes effect after a restart. Saved on this machine, never in presets; System default follows macOS.",
  },
  "device.output": {
    title: "Output",
    body: "Where the click, drums, file and loop play. Takes effect after a restart.",
  },
  "latency.measure": {
    title: "Measure latency",
    body: "Plays a short sweep and listens for it, to find how long sound takes to go out and come back in. Put the microphone against the speaker or inside a headphone cup. Offers the result -- nothing changes until you apply it.",
  },
  bufferCompensation: {
    title: "Latency (frames)",
    body: "The round-trip delay between the app making a sound and hearing it back, so your playing is drawn where you played it. If everything you play draws early or late against the grid, this is wrong -- measure it. Saved for each input and output pair.",
  },
  audioInGain: {
    title: "Input gain",
    body: "Turns the incoming signal up or down before anything else sees it.",
  },
  "channels.color": { title: "Color", body: "This channel's color, used in every pane." },
  "channels.opacity": { title: "Opacity", body: "How strongly this channel draws." },
  "channels.level": {
    title: "Display level",
    body: "How big this channel draws, so a quiet mic and a hot line can share a row. Only the picture. Double-click to reset.",
  },
  "channels.pan": {
    title: "Pan",
    body: "Where this input sits left to right when you hear it back. Double-click to centre.",
  },
  "bleed.measure": {
    title: "Measure speaker bleed",
    body: "For playing on speakers instead of headphones. Plays a couple of seconds of noise and learns how the room brings the app's sound back into the microphone. Stay quiet while it runs.",
  },
  bleedCancelOn: {
    title: "Hide the app's sound from the picture",
    body: "Takes the click and the drums back out of what's drawn, so bars of them don't cover your playing. Only the picture; the loop has its own switch.",
  },
  bleedTrackOn: {
    title: "Keep adapting",
    body: "Follows the room as it changes -- your hands over the keyboard are part of it. Only learns from moments it can already explain, so it holds still while you play.",
  },
  "setup.run": {
    title: "Run setup again",
    body: "Walks through choosing devices, checking the microphone, speakers or headphones, and measuring latency -- the same controls as this tab, in order, with an explanation for each.",
  },
  updates: {
    title: "Updates",
    body: "The version running, and a check for a newer one. Installing restarts the app.",
  },

  // ---- analysis ----
  highPassOn: {
    title: "High-pass filter",
    body: "Filters out the low end of the input, so the start of each note stands out from the body of the sound. Changes the picture only, unless the next switch is on.",
  },
  highPassHz: {
    title: "Cutoff (Hz)",
    body: "Below this frequency is filtered out. Around 800 suits most instruments.",
  },
  highPassAudio: {
    title: "Filter what you hear too",
    body: "Also filters what you hear back and what the looper records, so you can hear what the picture is showing.",
  },
  analysisOn: {
    title: "Spectrum analysis",
    body: "The analysis behind spectrogram panes, attack strength and note starts. Off, all three stop.",
  },
  analysisWindow: {
    title: "Analysis window",
    body: "How much sound each analysis step looks at. Shorter is sharper in time and places note starts more precisely; longer tells frequencies apart better.",
  },
  analysisBandLow: {
    title: "Attack band low (Hz)",
    body: "Attack strength only listens above this frequency. Raise it so a bass note doesn't read as a drum hit.",
  },
  analysisBandHigh: {
    title: "Attack band high (Hz)",
    body: "Attack strength only listens below this frequency.",
  },
  onsetThreshold: {
    title: "Threshold",
    body: "How far a peak in attack strength has to stand above what's typical just before it to count as a note start. Higher finds fewer.",
  },
  onsetMinGap: {
    title: "Minimum gap (ms)",
    body: "After a note start on a channel, ignore any other for this long, so one broad attack isn't reported twice.",
  },
  onsetOffset: {
    title: "Offset (ms)",
    body: "Moves detected note starts by this many milliseconds, to line them up with where you hear the attack.",
  },
  showFrameTime: {
    title: "Show frame time",
    body: "Overlays how long drawing takes each frame, and the gap between frames. A diagnostic.",
  },
};
