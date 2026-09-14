import { Input } from "../Input";
import { LoopGuardMeter } from "../LoopGuardMeter";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// What comes back to you: the looper, whether your live playing is heard and
// drawn alongside its echoes, and what keeps the loop from feeding back on
// speakers. The looper's on/off switch is pinned above the tabs.
export const LoopTab = (p: PanelProps) => {
  const { get, set, params } = p;
  return (
    <>
      <Section label="Looper">
        <Input label="Loop length (beats)" _key="beatsToLoop" params={params} set={set} get={get} />
        <Input
          label="Echoes"
          _key="loopEchoes"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => n >= 1 && n <= 16}
        />
        <Input
          label="Echo volume"
          _key="loopEchoGain"
          params={params}
          set={set}
          get={get}
          validate={(n: number) => n >= 0 && n <= 1}
        />
      </Section>
      {/* Together these answer one question: are you hearing and seeing
          yourself, or only the echoes? */}
      <Section label="Live input">
        <Input label="Hear live input" _key="audioMonitorOn" set={set} get={get} />
        <Input label="Draw live input" _key="visualMonitorOn" set={set} get={get} />
      </Section>
      {/* Here rather than with the rest of the bleed controls in setup,
          because it changes what the looper records. It still depends on the
          measurement made there, which its help says. */}
      <Section label="On speakers">
        <Input
          label="Keep the app's sound out of the loop"
          _key="bleedCancelAudioOn"
          set={set}
          get={get}
        />
        <Input
          label="Stop feedback runaway"
          _key="loopFeedbackGuardOn"
          set={set}
          get={get}
        />
        <LoopGuardMeter active={get("loopFeedbackGuardOn")} />
      </Section>
    </>
  );
};
