// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../../infrastructure/api/client.js";
import { FlowDetailView } from "./flow-detail.js";

vi.mock("../../infrastructure/api/client.js", async (load) => ({
  ...(await load<typeof import("../../infrastructure/api/client.js")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Flow detail", () => {
  it.each(["draft", "published"] as const)(
    "renders the authored %s plan without exposing protected reference IDs",
    async (kind) => {
      vi.mocked(api).mockResolvedValue({
        id: "flow-1",
        projectId: "project-1",
        name: "Login Flow",
        description: "",
        state: "editing",
        lifecycleState: kind === "draft" ? "editing" : "published",
        version: 3,
        content: { objective: "Authenticate safely" },
        plan: {
          steps: [
            {
              id: "fill-password",
              title: "Fill password",
              action: {
                type: "fill",
                secretRef: "11111111-1111-4111-8111-111111111111",
                target: {
                  concept: "password",
                  preferredEvidence: { roles: ["textbox"], names: [], labels: [] },
                },
              },
              assertions: [{ type: "value_change" }],
            },
          ],
        },
        probes: [],
        compilations: [],
        events: [],
      });

      render(<FlowDetailView flowId="flow-1" kind={kind} onBack={vi.fn()} />);

      expect(await screen.findByText("Login Flow")).toBeTruthy();
      expect(screen.getByText("Fill password")).toBeTruthy();
      expect(screen.getByText("password")).toBeTruthy();
      expect(screen.getByText("Protected reference configured")).toBeTruthy();
      expect(screen.queryByText("11111111-1111-4111-8111-111111111111")).toBeNull();
      expect(api).toHaveBeenCalledWith(kind === "draft" ? "/flow-drafts/flow-1" : "/flows/flow-1");
    },
  );
});
