// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../../infrastructure/api/client.js";
import { Flows } from "./flows.js";

vi.mock("../../infrastructure/api/client.js", async (load) => ({
  ...(await load<typeof import("../../infrastructure/api/client.js")>()),
  api: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Flows dashboard", () => {
  it("renders draft and published lifecycle records and opens their discriminated routes", async () => {
    vi.mocked(api).mockImplementation(async (path) => path.includes("/flows?") ? [
      flow("draft-1", "draft", "editing", "Draft checkout"),
      flow("published-1", "published", "published", "Published checkout"),
    ] : [{ id: "mission-1", title: "Checkout Mission" }]);
    const open = vi.fn();
    render(<Flows projectId="project-1" scopedMissionId="mission-1" onBack={vi.fn()} onOpenFlow={open} />);

    fireEvent.click(await screen.findByRole("button", { name: /Draft checkout/i }));
    fireEvent.click(screen.getByRole("button", { name: /Published checkout/i }));

    expect(screen.getByText("editing")).toBeTruthy();
    expect(screen.getByText("Published")).toBeTruthy();
    expect(open.mock.calls).toEqual([["draft", "draft-1"], ["published", "published-1"]]);
  });

  it("shows a genuine empty state only when neither lifecycle has records", async () => {
    vi.mocked(api).mockImplementation(async (path) => path.includes("/flows?") ? [] : [{ id: "mission-1", title: "Empty Mission" }]);
    render(<Flows projectId="project-1" scopedMissionId="mission-1" onBack={vi.fn()} onOpenFlow={vi.fn()} />);
    expect(await screen.findByText("No Flows for this Mission")).toBeTruthy();
  });
});

function flow(id: string, recordKind: "draft" | "published", lifecycleState: string, name: string) {
  return { id, recordKind, lifecycleState, name, description: "", latestVersion: 1,
    latestContent: { objective: "Observe checkout", expectedOutcomes: [] }, stepCount: 0, navigationCount: 0,
    missionLinks: [{ missionId: "mission-1", objectiveId: "objective-1", missionTitle: "Checkout Mission" }] };
}
