import { Field } from "@base-ui/react/field";
import { useState } from "react";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectGroup,
  SelectItem,
} from "../ui/select";
import type { SettingsSkill, SkillEnvironmentTarget } from "./projectSkillFiles";

export function AddSkillDialog({
  targets,
  onClose,
  onCreated,
}: {
  targets: readonly SkillEnvironmentTarget[];
  onClose: () => void;
  onCreated: (skill: SettingsSkill) => void;
}) {
  const destinations = targets.flatMap((target) => [
    ...target.workspaceRoots.map((cwd) => ({
      ...target,
      cwd,
      label: `${target.environmentLabel}: ${cwd}`,
      key: JSON.stringify([target.environmentId, cwd]),
    })),
    {
      ...target,
      cwd: undefined,
      label: `${target.environmentLabel}: Personal`,
      key: JSON.stringify([target.environmentId, null]),
    },
  ]);
  const [destinationKey, setDestinationKey] = useState(destinations[0]?.key ?? "");
  const destination = destinations.find((entry) => entry.key === destinationKey);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createSkill = useAtomCommand(projectEnvironment.createSkill, { reportFailure: false });
  const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;

  async function submit() {
    if (!destination || !validName || !instructions.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createSkill({
        environmentId: destination.environmentId,
        input: {
          ...(destination.cwd ? { cwd: destination.cwd } : {}),
          name,
          description,
          instructions,
        },
      });
      if (result._tag === "Success") {
        onCreated({
          ...result.value,
          environmentId: destination.environmentId,
          environmentLabel: destination.environmentLabel,
        });
      } else {
        setError(
          "Could not create the skill. Check that the name is available and the folder is writable.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add skill</DialogTitle>
            <DialogDescription>
              Create a SKILL.md file in the selected location's .agents/skills folder.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 py-4">
            <Field.Root className="flex flex-col gap-2">
              <Label htmlFor="skill-destination">Location</Label>
              <Select
                value={destinationKey}
                onValueChange={(value) => {
                  if (value) setDestinationKey(value);
                }}
                disabled={saving}
                items={destinations.map((entry) => ({ value: entry.key, label: entry.label }))}
              >
                <SelectTrigger id="skill-destination">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectGroup>
                    {destinations.map((entry) => (
                      <SelectItem key={entry.key} value={entry.key}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
            </Field.Root>
            <Field.Root className="flex flex-col gap-2">
              <Label htmlFor="skill-name">Name</Label>
              <Input
                nativeInput
                id="skill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={64}
                placeholder="review-changes"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and single hyphens.
              </p>
            </Field.Root>
            <Field.Root className="flex flex-col gap-2">
              <Label htmlFor="skill-description">Description</Label>
              <Input
                nativeInput
                id="skill-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4096}
                disabled={saving}
              />
            </Field.Root>
            <Field.Root className="flex flex-col gap-2">
              <Label htmlFor="skill-instructions">Instructions</Label>
              <Textarea
                id="skill-instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                required
                rows={7}
                maxLength={100_000}
                disabled={saving}
              />
            </Field.Root>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !destination || !validName || !instructions.trim()}
            >
              {saving ? "Creating..." : "Create skill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
