// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LegalPage } from "./LegalPage.js";
import { privacyPolicy, termsOfService } from "./policies.js";

afterEach(cleanup);

describe("public policies", () => {
  it.each([privacyPolicy, termsOfService])(
    "renders $title with complete navigation and contact",
    (policy) => {
      const previousTitle = document.title;
      const view = render(<LegalPage policy={policy} />);
      expect(document.title).toBe(`${policy.title} · Scry`);
      expect(screen.getByRole("heading", { level: 1, name: policy.title })).toBeTruthy();
      const navigation = screen.getByRole("navigation", { name: "Legal documents" });
      expect(
        within(navigation).getByRole("link", { name: policy.title }).getAttribute("aria-current"),
      ).toBe("page");
      for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
        expect(document.getElementById(link.hash.slice(1))).toBeTruthy();
      }
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        screen.getAllByRole("link", { name: "Contact support" })[0]!.getAttribute("href"),
      ).toBe("mailto:kamilhabib556@gmail.com");
      expect(view.container.textContent).not.toMatch(
        /\bKamil\b|\bKameo\b|operated by|\bbeta\b|kamilhabib556@gmail\.com/i,
      );
      expect(
        screen.queryByText(/review draft|not published or effective|before publication/i),
      ).toBeNull();
      view.unmount();
      expect(document.title).toBe(previousTitle);
    },
  );

  it("discloses narrow Google access, best-effort masking and the manual deletion contact", () => {
    render(<LegalPage policy={privacyPolicy} />);
    expect(
      screen.getByText(/Google sign-in requests only OpenID, email and basic profile/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Automatic redaction is best effort. Sensitive information may remain/),
    ).toBeTruthy();
    expect(
      screen.getByText(/request access, correction, account closure or deletion/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Removing that connection is separate from requesting deletion/),
    ).toBeTruthy();
  });
});
