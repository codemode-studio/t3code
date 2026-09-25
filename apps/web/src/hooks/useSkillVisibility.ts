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
  function setVisible(environmentId: EnvironmentId, path: string, visible: boolean) {
    const normalizedPath = path.replaceAll("\\", "/");
    setHidden((previous) => {
      const paths = previous[environmentId] ?? [];
      return {
        ...previous,
        [environmentId]: visible
          ? paths.filter((entry) => entry !== normalizedPath)
          : [...new Set([...paths, normalizedPath])],
      };
    });
  }
  return { hiddenByEnvironment, setVisible };
}
