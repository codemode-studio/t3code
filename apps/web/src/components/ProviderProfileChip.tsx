import type { CSSProperties } from "react";

import { Badge } from "./ui/badge";

/** A provider profile's name tinted with its color, for pickers and settings rows. */
export function ProviderProfileChip({
  name,
  color,
  size = "default",
}: {
  name: string;
  color?: string | undefined;
  size?: "sm" | "default";
}) {
  return (
    <Badge
      variant="label"
      size={size}
      style={{ "--label": color ?? "var(--color-muted-foreground)" } as CSSProperties}
    >
      <span className="size-1.5 rounded-full bg-(--label)" aria-hidden />
      {name}
    </Badge>
  );
}
