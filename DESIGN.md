# T3 Code product design

This file guides design decisions in T3 Code's web, desktop, and mobile clients. Marketing has its own design context. The guidance covers the product's character and the choices that should remain consistent across features. Choose each view's layout from its user's task while keeping it recognizable as T3 Code.

## The user's job

T3 Code is a workspace for directing coding agents and following their work. People keep it open for hours, switch among projects and threads, and may connect to an environment on another machine. They need to know where they are, what an agent is doing, what changed, and what they can do next.

Start a design by identifying the user's immediate task, the information needed to complete it, and the action that matters most. Let that task determine the layout. A conversation, an editor, a list of runs, and a settings page need different compositions within one visual language.

Protect these outcomes when choices compete:

1. Show true state. Never imply an agent is running, a change is saved, or a remote environment is reachable until the product knows it is.
2. Make the current project, thread, environment, selection, and available action clear where they affect a decision.
3. Keep long sessions fast and readable. Dense information is useful on desktop; excess decoration and constant repainting are not.
4. Carry the same task across web, desktop, and mobile, adapting the amount shown at once to each screen.

## Visual character

T3 Code's character comes from real conversations, project names, code, diffs, and accurate agent status. Favor compact, legible controls and quiet surfaces that leave room for those artifacts. Use color to distinguish state and action; use contrast, alignment, and space for most hierarchy. A theme may change the palette while preserving what looks primary and interactive. Use the system sans stack for interface text and monospace for code, paths, commands, and logs.

Avoid these recurring failures:

- **Status theater:** a spinner, glow, or success treatment that looks convincing but does not reflect the underlying state.
- **Ornamental dashboards:** cards, badges, gradients, or charts added to make a thin page feel complete instead of helping someone act on real information.
- **Orphan controls:** an action placed far from the item or context it affects, or made to look like body text when it navigates or changes state.
- **Inconsistent chrome:** peer pages using different title scales, search treatments, dividers, or control sizes without a task-based reason.

## Composition and hierarchy

Give the user's work the largest, clearest region. Navigation and metadata support it. Use a list and detail layout when people need to scan items and inspect one; use the full workspace when the content or editor needs the width. Let independent panes scroll independently, with controls that govern a pane staying with that pane.

Use a stable workspace header for location and page identity. A divider belongs under a header or control row when it separates regions that scroll or serve different jobs. Do not add borders to every row to manufacture structure. In a list, spacing, alignment, and selected state should carry most of the hierarchy.

Use one primary action per immediate task. Keep related actions with the thing they affect: editing actions by the editor, filters with their list, and navigation to related content with the item's context. Do not leave an action alone at the bottom of a large pane or center a full-width button when the action reads as a short link.

Text hierarchy should remain calm. Workspace labels and controls use the shared small text scale; an editable document title can be larger and stronger. Use muted text for secondary facts, not for the only clue to an item's identity. Align icons with their labels and reuse the same treatment for peer destinations.

## Controls and content

Use the installed UI components and their variants for controls, states, typography, colors, and focus behavior. On web and desktop, the shared [workspace header](apps/web/src/components/WorkspacePageHeader.tsx), [breadcrumb](apps/web/src/components/WorkspaceBreadcrumb.tsx), and [UI components](apps/web/src/components/ui) are the starting points. The semantic theme tokens live in [index.css](apps/web/src/index.css). Use those tokens so light, dark, custom, and translucent themes remain coherent. Mobile uses its native components, but should preserve the same hierarchy and state meaning.

Use the shared search, select, and button treatments rather than browser-default controls mixed into a styled pane. An editor should reveal enough content to work without making a short entry occupy most of the viewport. Its visible frame and editable area must resize together. Long content may scroll inside the field or its pane.

Write labels that describe the action or state directly. Empty states should say what is absent and offer a useful next action when one exists. Loading, disconnected, failed, and saved states must be distinguishable. Do not use animation, a spinner, or a success message to cover uncertainty about the real state.

## Across screens and motion

Desktop can show navigation, a list, and detail together when each helps the current task. On narrow screens, prioritize the current action and make the path back to the list obvious. Keep essential controls reachable; reducing width must not silently remove the only way to select or create an item.

Motion should explain a spatial change or confirm an action. Keep it short and interruptible, honor reduced-motion settings, and avoid continuously repainting effects. The app must remain responsive during long threads, streaming output, and remote updates.

## Review the result

Compare a new view with a shipped peer for typography, control scale, borders, spacing, focus, and selection. Then inspect the states that change its composition: empty and populated, selected and unselected, short and long content, narrow and wide widths, light and dark themes, and local and remote environments where relevant. A static code check cannot establish that an editor fits or an action reads in the right place; use a real client when verification is authorized.

When a design correction repeats, record the general decision here. Put reusable mechanics in a shared component or token, and use a targeted check for failures code can detect. Do not add a rule that merely describes one screenshot or one feature's current markup.
