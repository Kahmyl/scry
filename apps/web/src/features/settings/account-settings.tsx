import {
  AlertTriangle,
  Box,
  Check,
  CheckCircle2,
  Copy,
  Gauge,
  KeyRound,
  PlugZap,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  api,
  patch,
  post,
  remove,
  type Calibration,
  type Credential,
  type CredentialIncident,
  type Environment,
  type McpAccessToken,
  type Project,
  type VeilPreferenceRecord,
} from "../../infrastructure/api/client.js";
import { Modal } from "../../shared/components/dashboard-controls.js";
import { EmptyBlock, PageTitle } from "../../shared/components/dashboard-primitives.js";
import { veilPolicyIdentity, veilTighteningOptions } from "../../shared/state/dashboard-state.js";
import { publicConfig } from "../../infrastructure/config/runtime-config.js";

export function AccountSettings({ userEmail }: { userEmail: string }) {
  return (
    <>
      <PageTitle
        eyebrow="PERSONAL ACCOUNT"
        title="Account settings"
        copy="Your identity and sign-in details across every Scry workspace."
      />
      <section className="account-settings-grid">
        <div className="panel account-settings-card">
          <div className="account-settings-icon">
            <Settings2 size={20} />
          </div>
          <div>
            <span className="eyebrow">PROFILE</span>
            <h3>Account identity</h3>
            <p>The email address associated with your Scry account.</p>
          </div>
          <div className="account-setting-row">
            <span>Email address</span>
            <strong>{userEmail}</strong>
          </div>
        </div>
        <div className="panel account-settings-card">
          <div className="account-settings-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <span className="eyebrow">AUTHENTICATION</span>
            <h3>Secure sign-in</h3>
            <p>
              Password, email verification, and connected sign-in providers are managed securely
              through Supabase.
            </p>
          </div>
          <div className="account-setting-row">
            <span>Status</span>
            <strong className="account-status">
              <i /> Active
            </strong>
          </div>
        </div>
        <div className="panel account-settings-card">
          <div className="account-settings-icon">
            <Gauge size={20} />
          </div>
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h3>Personal defaults</h3>
            <p>Display, time zone, and notification preferences belong only to your account.</p>
          </div>
          <div className="account-setting-row">
            <span>Time zone</span>
            <strong>{Intl.DateTimeFormat().resolvedOptions().timeZone}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
