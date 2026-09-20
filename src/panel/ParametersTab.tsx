import { ParameterList } from "../ParameterList";
import { Section } from "./chrome";
import { PanelProps } from "./types";

// A rail entry rather than pinned above the tabs, which it was so that `n`
// could be edited while looking at a field that reads `bar/n x n`. That is a
// real loss and it is the owner's call: three boxes standing open above every
// tab was the larger cost. The list shows what each name resolves to, so the
// number is at least readable from here.
export const ParametersTab = (p: PanelProps) => (
  <Section>
    <ParameterList
      parameters={p.get("parameters")}
      setParameters={p.setParameters}
      reroll={p.reroll}
    />
  </Section>
);
