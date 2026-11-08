// @vitest-environment jsdom
// The real Supabase SDK consumes a fictional implicit callback and calls a local
// provider double. No hosted account, password or authentication token is used.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  client: null as SupabaseClient | null,
  initialRecovery: false,
  fetch: vi.fn(),
}));
vi.mock("../infrastructure/auth/supabase.js", () => ({
  isSupabaseConfigured: true,
  get supabase() {
    return provider.client;
  },
  get initialPasswordRecovery() {
    return provider.initialRecovery;
  },
  supabaseConfigurationMessage: "Authentication is not configured.",
}));
vi.mock("./Dashboard.js", () => ({ Dashboard: () => <p>Ordinary workspace</p> }));
import { ProductApp } from "./ProductApp.js";

const user = {
  id: "58551b65-0000-4000-8000-000000000000",
  email: "fictional-reviewer@example.test",
  aud: "authenticated",
  role: "authenticated",
  created_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
};

beforeEach(() => {
  provider.fetch.mockReset();
  provider.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify(user), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })}.fictional-signature`;
  window.history.replaceState(
    null,
    "",
    `/#access_token=${token}&refresh_token=fictional-refresh&expires_in=3600&token_type=bearer&type=recovery`,
  );
  provider.initialRecovery = true;
  provider.client = createClient("https://auth.example.test", "fictional-publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: true },
    global: { fetch: provider.fetch },
  });
});
afterEach(() => {
  cleanup();
  provider.client?.auth.stopAutoRefresh();
  window.history.replaceState(null, "", "/");
});

it("completes a real SDK recovery callback through a provider-confirmed password update", async () => {
  render(
    <MemoryRouter>
      <ProductApp />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Set a new password" });
  expect(window.location.hash).toBe("");
  expect(screen.queryByText("Ordinary workspace")).toBeNull();
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "fictional-new-password" },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "fictional-new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  await screen.findByRole("heading", { name: "Password updated" });
  const update = provider.fetch.mock.calls.find(([, options]) => options.method === "PUT");
  expect(update?.[0]).toBe("https://auth.example.test/auth/v1/user");
  expect(JSON.parse(update?.[1].body)).toMatchObject({ password: "fictional-new-password" });
  expect(screen.queryByLabelText("New password")).toBeNull();
});
