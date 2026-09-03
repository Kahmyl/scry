// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../infrastructure/api/index.js";
import { BrowserV2Dashboard } from "./BrowserV2Dashboard.js";

vi.mock("../infrastructure/api/index.js", async (load) => ({
  ...(await load<typeof import("../infrastructure/api/index.js")>()),
  api: vi.fn(),
}));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("browser v2 production dashboard", () => {
  it("loads only the active project, Mission, Run, and report read models", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects")
        return [
          { id: "project-1", name: "Production baseline", description: "", createdAt: "now" },
        ];
      return [];
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <BrowserV2Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          "/projects",
          "/v2/projects/project-1/missions",
          "/v2/projects/project-1/runs",
          "/v2/projects/project-1/reports",
        ]),
      ),
    );
    expect(screen.queryByText("Operations")).toBeNull();
    expect(screen.queryByText("Project settings")).toBeNull();
  });
});
