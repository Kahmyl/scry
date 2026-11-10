import { supabase } from "../auth/supabase.js";
import { publicConfig } from "../config/runtime-config.js";

export const API_BASE = publicConfig.apiBaseUrl;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authenticatedHeaders(init?.headers);
  // Content-Type describes the request body, not the expected response. In
  // particular, Fastify rejects body-less DELETEs mislabeled as JSON.
  if (typeof init?.body === "string" && init.body.length > 0 && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401) await supabase?.auth.signOut();
    throw new Error(
      body?.message
        ? Array.isArray(body.message)
          ? body.message.join(", ")
          : body.message
        : `Request failed (${response.status})`,
    );
  }
  return body as T;
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function remove<T>(path: string) {
  return api<T>(path, { method: "DELETE" });
}
/** Playback cookies are narrow capabilities; account bearer headers stay in
 * authenticated fetch, never a media URL. Cross-origin use needs explicit CORS. */
export function videoPlayback<T>(path: string, init: RequestInit) {
  return api<T>(path, { ...init, credentials: "include" });
}

export async function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: await authenticatedHeaders(),
    ...(signal ? { signal } : {}),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Recording could not be loaded (${response.status})`);
  return response.blob();
}

async function authenticatedHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  if (data.session?.access_token) {
    headers.set("authorization", `Bearer ${data.session.access_token}`);
  }
  return headers;
}

export * from "./models.js";
