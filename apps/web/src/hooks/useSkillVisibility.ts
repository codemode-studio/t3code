import { setSkillPathVisibility } from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "./useLocalStorage";

const HiddenSkills = Schema.Record(Schema.String, Schema.Array(Schema.String));
const EMPTY: typeof HiddenSkills.Type = {};

/** Picker preferences belong to this client, with paths isolated by environment. */
export function useSkillVisibility() {
  const [hiddenByEnvironment, setHidden] = useLocalStorage(
    "t3code:hidden-skills",
    EMPTY,
    HiddenSkills,
  );
  function setVisible(environmentId: EnvironmentId, aliases: readonly string[], visible: boolean) {
    setHidden((previous) => {
      const paths = previous[environmentId] ?? [];
      return {
        ...previous,
        [environmentId]: setSkillPathVisibility(paths, aliases, visible),
      };
    });
  }
  return { hiddenByEnvironment, setVisible };
}
