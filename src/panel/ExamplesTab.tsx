import { ExampleBar } from "../ExampleBar";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// Unlabelled: the rail already says where you are, and a caption repeating it
// is one more thing to read. Every other section's captions name a *group
// inside* it, which is a different job.
export const ExamplesTab = (
  p: PanelProps & { onLoaded: (id: string) => void }
) => (
  <Section>
    <ExampleBar onLoad={p.loadPreset} onLoaded={p.onLoaded} />
  </Section>
);
