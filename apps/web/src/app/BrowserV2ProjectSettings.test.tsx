// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, post } from "../infrastructure/api/index.js";
import { BrowserV2ProjectSettings } from "./BrowserV2ProjectSettings.js";

vi.mock("../infrastructure/api/index.js", async (load) => ({
  ...(await load<typeof import("../infrastructure/api/index.js")>()),
  api: vi.fn(),
  post: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("browser v2 Project settings", () => {
  it("lists only safe credential metadata and stores a new protected value", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce([
        {
          id: "credential-1",
          referenceId: "credential-1",
          projectId: "project-1",
          displayName: "Vitract_password",
          state: "active",
          createdAt: "2026-09-03T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(post).mockResolvedValue({ protectedValueId: "credential-2", replay: false });

    render(<BrowserV2ProjectSettings projectId="project-1" />);
    expect(await screen.findByText("Vitract_password")).toBeTruthy();
    expect(screen.getByText("••••••••••••")).toBeTruthy();
    expect(screen.getByText(/must ask you to select it before first use/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add credential" }));
    fireEvent.change(screen.getByPlaceholderText("Vitract test account password"), {
      target: { value: "Vitract_email" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter the actual value"), {
      target: { value: "owner@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/v2/projects/project-1/protected-inputs",
        expect.objectContaining({
          displayName: "Vitract_email",
          value: "owner@example.test",
          expiresInSeconds: null,
        }),
      ),
    );
    expect(api).toHaveBeenCalledWith("/v2/projects/project-1/protected-inputs");
  });
});
