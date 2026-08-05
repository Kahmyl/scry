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
import { publicConfig } from "../../infrastructure/config/runtime-config.js";

export function WorkspaceSettings({
  userEmail,
  projects,
}: {
  userEmail: string;
  projects: Project[];
}) {
  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE SCOPE"
        title="Workspace settings"
        copy="Shared ownership, projects, and access across your Scry workspace."
      />
      <section className="settings-grid">
        <div className="panel settings-card">
          <div className="account-settings-icon">
            <Box size={20} />
          </div>
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h3>Scry workspace</h3>
            <p>The shared boundary containing your projects and durable test history.</p>
          </div>
          <dl>
            <div>
              <dt>Projects</dt>
              <dd>{projects.length}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>Local development</dd>
            </div>
          </dl>
        </div>
        <div className="panel settings-card">
          <div className="account-settings-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <span className="eyebrow">MEMBERS & ACCESS</span>
            <h3>Workspace owner</h3>
            <p>Team roles and invitations will be managed at this scope.</p>
          </div>
          <dl>
            <div>
              <dt>Owner</dt>
              <dd>{userEmail}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>Administrator</dd>
            </div>
          </dl>
        </div>
      </section>
      <section className="panel settings-note">
        <AlertTriangle size={18} />
        <div>
          <strong>Team management is not enabled yet</strong>
          <span>
            The current local workspace has one owner. Invitations and role controls will appear
            here when multi-user access is enabled.
          </span>
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
