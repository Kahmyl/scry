import { createClient } from "@supabase/supabase-js";
import { publicConfig } from "./runtime-config.js";

const url = publicConfig.supabaseUrl;
const publishableKey = publicConfig.supabasePublishableKey;

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
