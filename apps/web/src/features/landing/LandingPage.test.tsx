// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage.js";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const onSignIn = vi.fn(),
    onSignUp = vi.fn();
  render(<LandingPage onSignIn={onSignIn} onSignUp={onSignUp} />);
  return { onSignIn, onSignUp };
}
describe("adopted landing page", () => {
  it("retains the recognizable original headline and brand", () => {
    mount();
    expect(
      screen.getByRole("heading", { level: 1, name: /Your product changed.*Know what broke/ }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Scry home" })).toBeTruthy();
    expect(document.querySelectorAll('img[src="/brand/scry-symbol.svg"]').length).toBe(2);
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
  });
  it("wires every signup CTA to the supplied callback without an auth implementation", () => {
    const { onSignIn, onSignUp } = mount();
    for (const name of ["Start testing", "Create your workspace", "Build your first test"])
      fireEvent.click(screen.getByRole("button", { name }));
    expect(onSignUp).toHaveBeenCalledTimes(3);
    expect(onSignIn).not.toHaveBeenCalled();
    expect(document.querySelectorAll("input,form").length).toBe(0);
  });
  it("keeps signin distinct from signup", () => {
    const { onSignIn, onSignUp } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignUp).not.toHaveBeenCalled();
  });
  it("resolves all section links to actual unique page targets", () => {
    mount();
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))
      expect(document.getElementById(link.hash.slice(1))).toBeTruthy();
  });
  it("opens navigation, closes on Escape and restores keyboard focus", () => {
    mount();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByRole("navigation", { name: "Main navigation" }).id,
    );
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
  it("closes mobile navigation after choosing a section", () => {
    mount();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("link", {
        name: "How it works",
      }),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
  it("closes mobile navigation before calling either account callback", () => {
    const { onSignIn, onSignUp } = mount();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    for (const name of ["Sign in", "Start testing"]) {
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole("button", { name }));
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignUp).toHaveBeenCalledTimes(1);
  });
  it("clearly labels fictional report and policy instead of implying real results", () => {
    mount();
    expect(screen.getByText("EXAMPLE DATA")).toBeTruthy();
    expect(screen.getByText("Example report · fictional data")).toBeTruthy();
    expect(screen.getByText("Observations require human review")).toBeTruthy();
    expect(screen.getByText(/Illustrative settings, not a live policy/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Observations, not verdicts" })).toBeTruthy();
  });
  it("removes the Escape listener when unmounted", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const rendered = render(<LandingPage onSignIn={() => {}} onSignUp={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    rendered.unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    remove.mockRestore();
  });
});
