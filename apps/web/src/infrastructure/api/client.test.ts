import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, apiBlob, post, remove } from "./client.js";
import { supabase } from "../auth/supabase.js";

vi.mock("../auth/supabase.js", () => ({
  supabase: { auth: { getSession: vi.fn(), signOut: vi.fn() } },
}));
vi.mock("../config/runtime-config.js", () => ({ publicConfig: { apiBaseUrl: "/api" } }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(supabase!.auth.getSession).mockResolvedValue({
    data: { session: { access_token: "fictional-dashboard-session" } },
    error: null,
  } as Awaited<ReturnType<NonNullable<typeof supabase>["auth"]["getSession"]>>);
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    // Fastify rejects an empty DELETE carrying application/json before auth or
    // the disconnect handler. Model that real protocol boundary here.
    if (
      init.method === "DELETE" &&
      new Headers(init.headers).get("content-type") === "application/json" &&
      !init.body
    )
      return new Response("Body cannot be empty", { status: 400 });
    return new Response(JSON.stringify({ disconnected: true }), {
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("authenticated HTTP request envelopes", () => {
  it("sends a body-less DELETE without a JSON content type", async () => {
    expect(await remove("/integrations/connections/fictional-connection")).toEqual({
      disconnected: true,
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fictional-dashboard-session",
    );
  });

  it("does not label body-less reads or empty POSTs as JSON", async () => {
    await api("/integrations/connections");
    await api("/fictional-empty-action", { method: "POST" });
    for (const [, init] of fetchMock.mock.calls)
      expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("preserves the JSON write envelope and explicit caller content types", async () => {
    await post("/fictional-action", { decision: "approve" });
    const json = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(json.headers).get("content-type")).toBe("application/json");
    expect(json.body).toBe('{"decision":"approve"}');
    await api("/fictional-action", {
      method: "POST",
      body: "fictional text",
      headers: { "content-type": "text/plain" },
    });
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get("content-type")).toBe("text/plain");
  });

  it("keeps media authentication, cancellation and no-store without a JSON body label", async () => {
    const controller = new AbortController();
    expect(await apiBlob("/runs/fictional/media/0", controller.signal)).toBeInstanceOf(Blob);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).has("content-type")).toBe(false);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fictional-dashboard-session",
    );
    expect(init.signal).toBe(controller.signal);
    expect(init.cache).toBe("no-store");
  });

  it("retains authentication failure handling", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "Sign in again" }), { status: 401 }),
    );
    await expect(remove("/integrations/connections/fictional-connection")).rejects.toThrow(
      "Sign in again",
    );
    expect(supabase!.auth.signOut).toHaveBeenCalledOnce();
  });
});
