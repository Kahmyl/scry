import { createClient } from "@supabase/supabase-js";
import { publicConfig } from "../config/runtime-config.js";

const url = publicConfig.supabaseUrl;
const publishableKey = publicConfig.supabasePublishableKey;

// Capture only the routing hint before the SDK consumes and removes the callback hash.
// The SDK must still validate the callback and session before a password can be changed.
export const initialPasswordRecovery =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery";

export const isSupabaseConfigured = Boolean(url && publishableKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const supabaseConfigurationMessage =
  "Configure the Supabase URL and publishable key for this deployment.";
