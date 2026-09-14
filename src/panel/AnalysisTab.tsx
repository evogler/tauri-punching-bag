import { analysisNyquist, ANALYSIS_WINDOWS } from "../config";
import { Help } from "../help";
import { Input } from "../Input";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// The expert knobs: filtering the input so attacks stand out, the spectrum
// analysis, tuning where note starts are detected, and a diagnostic. None of it
// is needed to practise, and all of it is kept.
export const AnalysisTab = (p: PanelProps) => {
  const { get, set, params, sampleRate } = p;
  return (
    <>
      <Section label="High-pass filter">
        <Input label="High-pass filter" _key="highPassOn" set={set} get={get} />
        <Input
          label="Cutoff (Hz)"
          _key="highPassHz"
          params={params}
          set={set}
          get={get}
        />
        <Input
          label="Filter what you hear too"
          _key="highPassAudio"
          set={set}
          get={get}
        />
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          {!get("highPassOn")
            ? "Off -- the picture is drawn from the input as it arrives."
            : get("highPassAudio")
            ? "12 dB/octave, on the picture and on the sound."
            : "12 dB/octave, on the picture only. The looper still records dry."}
        </div>
      </Section>
      <Section label="Spectrum">
        <Input label="Spectrum analysis" _key="analysisOn" set={set} get={get} />
        {/* Frequency resolution against time resolution, and the one knob
            for both: the hop is a quarter of the window, so a shorter one
            narrows the spectrogram's columns and places an attack more
            precisely at the cost of smearing the bass end further. Global
            rather than per-pane -- one FFT feeds every pane and the flux. */}
        <Help
          id="analysisWindow"
          style={{ display: "flex", flexDirection: "row", gap: "4px" }}
        >
          <label>Analysis window</label>
          <select
            value={get("analysisWindow")}
            onChange={(e) => set("analysisWindow", Number(e.target.value))}
          >
            {ANALYSIS_WINDOWS.map((n) => (
              <option key={n} value={n}>
                {n} ({Math.round((n / sampleRate) * 10000) / 10} ms)
              </option>
            ))}
          </select>
        </Help>
      </Section>
      <Section label="Note starts">
        {/* The band the flux is summed over. Global rather than per-pane:
            it's an audio-thread setting, and narrowing it onto what you're
            listening for is what stops a bass note reading as a snare hit. */}
        <Input
          label="Attack band low (Hz)"
          _key="analysisBandLow"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => n > 0 && n < analysisNyquist()}
        />
        <Input
          label="Attack band high (Hz)"
          _key="analysisBandHigh"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => n > 0 && n < analysisNyquist()}
        />
        {/* Peak picking. Relative to the flux's local median, so the
            threshold means the same thing loud or quiet; the gap is what
            stops one broad attack reporting its own shoulders. */}
        <Input
          label="Threshold"
          _key="onsetThreshold"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => Number.isFinite(n) && n >= 0}
        />
        <Input
          label="Minimum gap (ms)"
          _key="onsetMinGap"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => Number.isFinite(n) && n >= 0 && n < 10000}
        />
        <Input
          label="Offset (ms)"
          _key="onsetOffset"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => Number.isFinite(n) && Math.abs(n) < 10000}
        />
      </Section>
      <Section label="Diagnostics">
        <Input label="Show frame time" _key="showFrameTime" set={set} get={get} />
      </Section>
    </>
  );
};
