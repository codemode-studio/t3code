import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ProjectEnvironmentBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  return (
    <EnvironmentPresenceBadge
      environments={props.group.memberProjects.map((member) => ({
        environmentId: member.environmentId,
        label: member.environmentLabel ?? "Remote",
      }))}
      primaryEnvironmentId={props.primaryEnvironmentId}
      machineByEnvironmentId={props.machineByEnvironmentId}
    />
  );
}

export function EnvironmentPresenceBadge(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const remote = props.environments
    .filter((environment) => environment.environmentId !== props.primaryEnvironmentId)
    .toSorted((a, b) => a.label.localeCompare(b.label));
  const first = remote[0];
  if (!first) return null;
  const labels = remote
    .map((environment) => environment.label)
    .filter((label, index, all) => all.indexOf(label) === index)
    .join(", ");
  const alsoHere = remote.length < props.environments.length;
  const description = `${alsoHere ? "Also on" : "On"} ${labels}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={description}
            className="ml-auto inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={props.machineByEnvironmentId.get(first.environmentId) ?? "server"}
          className="size-3.5"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
