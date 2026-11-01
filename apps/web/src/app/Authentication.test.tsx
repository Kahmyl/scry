// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  initialize: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../infrastructure/auth/supabase.js", () => ({
  isSupabaseConfigured: true,
  supabase: { auth },
  supabaseConfigurationMessage: "Authentication is not configured.",
}));
vi.mock("./Dashboard.js", () => ({
  Dashboard: ({ userEmail, onSignOut }: { userEmail: string; onSignOut: () => void }) => (
    <section aria-label="Signed-in workspace">
      {userEmail}
      <button onClick={onSignOut}>Sign out</button>
    </section>
  ),
}));
import { Landing } from "../features/landing/Landing.js";
import { ProductApp } from "./ProductApp.js";

beforeEach(() => {
  vi.resetAllMocks();
  auth.initialize.mockResolvedValue({ error: null });
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});
afterEach(cleanup);

describe("public legal pages", () => {
  it.each([
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Service"],
  ])("opens %s without waiting for or starting session restoration", (path, title) => {
    auth.initialize.mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter initialEntries={[path]}>
        <ProductApp />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "kamilhabib556@gmail.com" }).length).toBeGreaterThan(
      0,
    );
    expect(auth.initialize).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("links to public policies from the homepage and preserves the sign-in form when reviewing terms", () => {
    render(<Landing authError="Sign in to continue." />);
    expect(screen.getByRole("contentinfo").querySelector('a[href="/privacy"]')).toBeTruthy();
    expect(screen.getByRole("contentinfo").querySelector('a[href="/terms"]')).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Sign in to Scry" });
    for (const name of ["Privacy Policy", "Terms of Service"]) {
      const link = within(dialog).getByRole("link", { name });
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("adopted landing account actions", () => {
  it("opens the real signup dialog from the primary CTA without submitting an account request", () => {
    render(<Landing />);
    fireEvent.click(screen.getByRole("button", { name: "Create your workspace" }));
    expect(screen.getByRole("dialog", { name: "Create a Scry account" })).toBeTruthy();
    expect(screen.getByLabelText("Work email")).toBeTruthy();
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
    expect(auth.signUp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: /Your product changed/ })).toBeTruthy();
  });
  it("closes the phone menu before opening real signin", () => {
    render(<Landing />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("dialog", { name: "Sign in to Scry" })).toBeTruthy();
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
  });
});

describe("Google OAuth sign-in", () => {
  it("keeps email sign-in wired to the existing provider and password input", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null, data: { session: null } });
    render(<Landing authError="Sign in to continue." />);
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "tester@example.test" },
    });
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");
    fireEvent.change(password, { target: { value: "fictional-test-password" } });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Sign in to Scry" })).getByRole("button", {
        name: /^Sign in$/,
      }),
    );
    await waitFor(() =>
      expect(auth.signInWithPassword).toHaveBeenCalledWith({
        email: "tester@example.test",
        password: "fictional-test-password",
      }),
    );
  });

  it("retains email verification and resend after sign-up without inventing an authenticated session", async () => {
    auth.signUp.mockResolvedValue({ error: null, data: { session: null } });
    auth.resend.mockResolvedValue({ error: null });
    render(<Landing authError="Sign in to continue." />);
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "tester@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "fictional-test-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create account$/ }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeTruthy();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "tester@example.test",
      password: "fictional-test-password",
      options: { emailRedirectTo: window.location.origin },
    });
    expect(screen.queryByLabelText("Signed-in workspace")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    await waitFor(() =>
      expect(auth.resend).toHaveBeenCalledWith({
        type: "signup",
        email: "tester@example.test",
        options: { emailRedirectTo: window.location.origin },
      }),
    );
    expect(await screen.findByText("A new verification email has been sent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in to your workspace" })).toBeTruthy();
  });
  it("reports callback cancellation from SDK initialization even when getSession succeeds with no session", async () => {
    auth.initialize.mockResolvedValue({ error: { message: "PRIVATE_CANCEL_DETAIL" } });
    render(
      <MemoryRouter>
        <ProductApp />
      </MemoryRouter>,
    );
    await screen.findByRole("dialog", { name: "Sign in to Scry" });
    expect(screen.getByRole("alert").textContent).toMatch(/try again/);
    expect(screen.queryByText(/PRIVATE_CANCEL_DETAIL/)).toBeNull();
  });

  it("does not discard an existing valid session when another sign-in callback fails", async () => {
    auth.initialize.mockResolvedValue({ error: { message: "PRIVATE_CALLBACK_DETAIL" } });
    auth.getSession.mockResolvedValue({
      data: { session: { user: { email: "owner@example.test" } } },
      error: null,
    });
    render(
      <MemoryRouter>
        <ProductApp />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Signed-in workspace");
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("uses Google and the current exact origin, without advertising unconfigured GitHub sign-in", async () => {
    auth.signInWithOAuth.mockResolvedValue({ error: null });
    render(<Landing authError="Please sign in again." />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() =>
      expect(auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: window.location.origin },
      }),
    );
    expect(screen.queryByRole("button", { name: /Continue with GitHub/ })).toBeNull();
  });

  it.each(["returned error", "network rejection"])(
    "allows retry after %s without showing provider internals",
    async (kind) => {
      if (kind === "returned error")
        auth.signInWithOAuth.mockResolvedValueOnce({
          error: { message: "PRIVATE_PROVIDER_DETAIL" },
        });
      else auth.signInWithOAuth.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAIL"));
      auth.signInWithOAuth.mockResolvedValueOnce({ error: null });
      render(<Landing authError="Please sign in again." />);
      fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/try again/));
      expect(screen.queryByText(/PRIVATE_PROVIDER_DETAIL/)).toBeNull();
      const retry = screen.getByRole("button", {
        name: "Continue with Google",
      }) as HTMLButtonElement;
      expect(retry.disabled).toBe(false);
      fireEvent.click(retry);
      await waitFor(() => expect(auth.signInWithOAuth).toHaveBeenCalledTimes(2));
    },
  );

  it("prevents a second sign-in request while the first is pending", async () => {
    let finish!: (value: { error: null }) => void;
    auth.signInWithOAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Landing authError="Please sign in again." />);
    const button = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(auth.signInWithOAuth).toHaveBeenCalledTimes(1);
    finish({ error: null });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(["callback error", "network rejection"])(
    "leaves session restoration safely after %s",
    async (kind) => {
      if (kind === "callback error")
        auth.getSession.mockResolvedValue({
          data: { session: null },
          error: { message: "PRIVATE_CALLBACK_DETAIL" },
        });
      else auth.getSession.mockRejectedValue(new Error("PRIVATE_CALLBACK_DETAIL"));
      render(
        <MemoryRouter>
          <ProductApp />
        </MemoryRouter>,
      );
      await screen.findByRole("dialog", { name: "Sign in to Scry" });
      expect(screen.getByRole("alert").textContent).toMatch(/try again/);
      expect(screen.queryByText(/PRIVATE_CALLBACK_DETAIL|RESTORING SECURE SESSION/)).toBeNull();
      expect(screen.queryByLabelText("Signed-in workspace")).toBeNull();
    },
  );

  it("shows the authenticated workspace after session restoration and signs out through Supabase", async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { user: { email: "owner@example.test" } } },
      error: null,
    });
    render(
      <MemoryRouter>
        <ProductApp />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Signed-in workspace");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
