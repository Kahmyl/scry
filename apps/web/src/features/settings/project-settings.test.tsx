// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, post } from "../../infrastructure/api/client.js";
import { CredentialDialog, Settings } from "./project-settings.js";

vi.mock("../../infrastructure/api/client.js", async (load) => ({
  ...(await load<typeof import("../../infrastructure/api/client.js")>()),
  api: vi.fn(),
  post: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Project credential dashboard creation", () => {
  it("stores protected information at Project scope without Mission selection", async () => {
    vi.mocked(post).mockResolvedValue({
      id: "credential-1",
      projectId: "project-1",
      name: "Preview password",
      securityStatus: "active",
      eligibleForAuthorization: true,
      authorizedEnvironmentIds: [],
      authorizedEnvironmentIdsTruncated: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const saved = vi.fn();
    render(<CredentialDialog projectId="project-1" onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(screen.getByPlaceholderText("Vitract test account password"), {
      target: { value: "Preview password" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter the actual value"), {
      target: { value: "protected-canary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects/project-1/credentials", {
        name: "Preview password",
        value: "protected-canary",
      }),
    );
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: "Preview password" }));
    expect(screen.queryByText(/Select a Mission objective/i)).toBeNull();
  });

  it("shows credential lifecycle state and warns when discovery is truncated", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith("/credential-candidates"))
        return {
          items: [
            {
              id: "credential-1",
              referenceId: "credential-1",
              projectId: "project-1",
              name: "Old preview password",
              securityStatus: "revoked",
              eligibleForAuthorization: false,
              authorizedEnvironmentIds: [],
              authorizedEnvironmentIdsTruncated: false,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          truncated: true,
        } as never;
      return [] as never;
    });
    render(<Settings projectId="project-1" />);
    expect(await screen.findByText(/Revoked · unavailable/i)).toBeTruthy();
    expect(screen.getByText(/More credentials exist/i)).toBeTruthy();
  });
});
