import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useResizableWidth } from "./useResizableWidth";

function Panel({
  edge = "left",
  maxWidth = 800,
  storageKey = "test-panel-width",
}: {
  edge?: "left" | "right";
  maxWidth?: number;
  storageKey?: string;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth: 400,
    minWidth: 200,
    maxWidth,
    edge,
  });
  return (
    <aside data-testid="host">
      <output>{width}</output>
      <div data-testid="handle" {...handlers} />
    </aside>
  );
}

it("restores a wide stored width into narrow bounds and recovers it when they grow", async () => {
  localStorage.setItem("wide-pane", "700");
  using setItem = vi.spyOn(Storage.prototype, "setItem");
  await using screen = await render(<Panel storageKey="wide-pane" maxWidth={300} />, {
    router: false,
  });
  const shownWidth = () => Number(screen.container.querySelector("output")!.textContent);
  try {
    expect(shownWidth()).toBe(300);
    await screen.rerender(<Panel storageKey="wide-pane" maxWidth={250} />);
    expect(shownWidth()).toBe(250);
    await screen.rerender(<Panel storageKey="wide-pane" maxWidth={800} />);
    expect(shownWidth()).toBe(700);
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    localStorage.removeItem("wide-pane");
  }
});
