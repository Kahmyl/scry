// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RunRecovery } from "./RunRecovery.js";

const client = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("../infrastructure/api/client.js", () => client);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("requires a fresh confirmation when the selected attempt changes", () => {
  const view = render(<RunRecovery runId="first" />);
  fireEvent.click(screen.getByRole("button", { name: "Finish attempt as incomplete" }));
  fireEvent.click(screen.getByRole("checkbox"));
  expect(
    (screen.getByRole("button", { name: "End incomplete attempt" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  view.rerender(<RunRecovery runId="second" />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Finish attempt as incomplete" }));
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(
    (screen.getByRole("button", { name: "End incomplete attempt" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(client.post).not.toHaveBeenCalled();
});

it("does not present an old attempt's delayed release result as the newly selected attempt", async () => {
  let resolve!: (value: unknown) => void;
  client.api.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<RunRecovery runId="first" />);
  fireEvent.click(screen.getByRole("button", { name: "Check attempt and browser release" }));
  view.rerender(<RunRecovery runId="second" />);
  await act(async () => {
    resolve({ terminal: true, browserReleased: true });
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Check attempt and browser release" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(client.api).toHaveBeenCalledExactlyOnceWith("/runs/first/status");
});
