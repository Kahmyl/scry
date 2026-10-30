import { supabase } from "../auth/supabase.js";
import { publicConfig } from "../config/runtime-config.js";

export const API_BASE = publicConfig.apiBaseUrl;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authenticatedHeaders(init?.headers);
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

async function authenticatedHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  if (data.session?.access_token) {
    headers.set("authorization", `Bearer ${data.session.access_token}`);
  }
  return headers;
}

export * from "./models.js";
