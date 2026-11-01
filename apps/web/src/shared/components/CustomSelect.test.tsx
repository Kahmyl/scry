// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSelectBrowserApis } from "../../../test/select-dom.js";
import { CustomSelect } from "./CustomSelect.js";

const options = [
  { value: "all", label: "All statuses", separatorAfter: true },
  { value: "running", label: "In progress" },
  { value: "blocked", label: "On hold", disabled: true },
  { value: "completed", label: "Completed" },
];
function Example({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("all");
  return (
    <>
      <CustomSelect
        label="Status"
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <button>Next control</button>
    </>
  );
}
const trigger = () => screen.getByRole("combobox", { name: "Status" });
function open() {
  fireEvent.keyDown(trigger(), { key: "ArrowDown" });
}
beforeEach(mockSelectBrowserApis);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("custom select interactions", () => {
  it("provides a custom listbox and updates a controlled selection", async () => {
    const change = vi.fn();
    render(<Example onChange={change} />);
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    open();
    expect(screen.getByRole("listbox", { name: "Status" })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "All statuses" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    fireEvent.click(screen.getByRole("option", { name: "In progress" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("running");
    expect(trigger().textContent).toBe("In progress");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("dismisses on Escape without changing selection and restores trigger focus", async () => {
    const change = vi.fn();
    render(<Example onChange={change} />);
    open();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });
  it("supports keyboard navigation and selection while skipping disabled items", async () => {
    const change = vi.fn();
    render(<Example onChange={change} />);
    open();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "All statuses" })),
    );
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "Completed" })),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "In progress" })),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(change).toHaveBeenCalledExactlyOnceWith("running");
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });
  it("supports typeahead without committing until confirmed", async () => {
    const change = vi.fn();
    render(<Example onChange={change} />);
    open();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "All statuses" })),
    );
    fireEvent.keyDown(document.activeElement!, { key: "c" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: "Completed" })),
    );
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(change).toHaveBeenCalledExactlyOnceWith("completed");
  });
  it("does not choose a disabled item", () => {
    const change = vi.fn();
    render(<Example onChange={change} />);
    open();
    fireEvent.click(screen.getByRole("option", { name: "On hold" }));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
  it("respects a controlled external reset", () => {
    const change = vi.fn();
    const view = render(
      <CustomSelect label="Status" value="running" onChange={change} options={options} />,
    );
    expect(trigger().textContent).toBe("In progress");
    view.rerender(<CustomSelect label="Status" value="all" onChange={change} options={options} />);
    expect(trigger().textContent).toBe("All statuses");
    expect(change).not.toHaveBeenCalled();
  });
  it("disables the whole control when requested", () => {
    render(
      <CustomSelect label="Status" value="all" onChange={() => {}} options={options} disabled />,
    );
    expect(trigger()).toHaveProperty("disabled", true);
    fireEvent.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("removes the portal and body interaction lock on unmount", () => {
    const previous = document.body.style.pointerEvents;
    const view = render(<Example />);
    open();
    expect(screen.getByRole("listbox")).toBeTruthy();
    view.unmount();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.body.style.pointerEvents).toBe(previous);
  });
});
