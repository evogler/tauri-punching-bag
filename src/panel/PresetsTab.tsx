import { PresetBar } from "../PresetBar";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// Separate from the examples, which is the decision recorded in
// docs/approachability.md: those are read-only and not yours, these are yours
// and can be deleted. Loading only *part* of a preset is meant to land here.
export const PresetsTab = (p: PanelProps) => (
  <Section>
    <PresetBar getCurrent={p.getCurrentPreset} onLoad={p.loadPreset} />
  </Section>
);
