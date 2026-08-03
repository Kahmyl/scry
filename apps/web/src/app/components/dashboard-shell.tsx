import {
  Activity,
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  Eye,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  PlugZap,
  Plus,
  Settings2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { post, type Project } from "../../infrastructure/api/index.js";
import { Modal } from "../../shared/components/index.js";
import type { DashboardView as View } from "../../shared/state/index.js";

export function Sidebar({
  projects,
  projectId,
  view,
  onSelectProject,
  onNavigate,
  onCreateProject,
}: {
  projects: Project[];
  projectId: string;
  view: View;
  onSelectProject: (id: string) => void;
  onNavigate: (view: View) => void;
  onCreateProject: () => void;
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const selectedProject = projects.find((project) => project.id === projectId);
  const nav: Array<[View, string, ReactNode]> = [
    ["overview", "Dashboard", <LayoutDashboard size={17} />],
    ["missions", "Missions", <Eye size={17} />],
    ["runs", "Runs", <Activity size={17} />],
    ["reports", "Reports", <FileText size={17} />],
  ];

  useEffect(() => {
    if (!projectMenuOpen) return;
    const closeProjectMenu = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeProjectMenu);
    return () => document.removeEventListener("pointerdown", closeProjectMenu);
  }, [projectMenuOpen]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Eye size={21} strokeWidth={2.3} />
        </div>
        <div>
          <strong>Scry</strong>
          <span>TEST INTELLIGENCE</span>
        </div>
      </div>
      <div className="project-switcher">
        <span className="eyebrow">PROJECT</span>
        <div className="project-select" ref={projectMenuRef}>
          <button
            className="project-select-trigger"
            onClick={() => setProjectMenuOpen((open) => !open)}
            aria-expanded={projectMenuOpen}
            aria-haspopup="listbox"
          >
            <span>{selectedProject?.name ?? "No projects yet"}</span>
            <ChevronDown size={16} />
          </button>
          {projectMenuOpen && (
            <div className="project-select-menu" role="listbox" aria-label="Select project">
              <div className="project-select-heading">Switch project</div>
              <div className="project-select-options">
                {projects.length ? (
                  projects.map((project) => (
                    <button
                      key={project.id}
                      className={project.id === projectId ? "selected" : ""}
                      onClick={() => {
                        onSelectProject(project.id);
                        setProjectMenuOpen(false);
                      }}
                      role="option"
                      aria-selected={project.id === projectId}
                    >
                      <span className="project-option-icon">
                        <Box size={15} />
                      </span>
                      <span className="project-option-copy">
                        <strong>{project.name}</strong>
                        <small>
                          {project.id === projectId ? "Current project" : "Open workspace"}
                        </small>
                      </span>
                      {project.id === projectId && <Check size={15} />}
                    </button>
                  ))
                ) : (
                  <div className="project-select-empty">
                    Create your first project to get started.
                  </div>
                )}
              </div>
              <button
                className="project-select-create"
                onClick={() => {
                  setProjectMenuOpen(false);
                  onCreateProject();
                }}
              >
                <Plus size={15} /> Create new project
              </button>
            </div>
          )}
        </div>
      </div>
      <nav>
        {nav.map(([key, label, icon]) => (
          <button
            key={key}
            className={view === key ? "nav-active" : ""}
            onClick={() => onNavigate(key)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className={view === "integrations" ? "nav-active" : ""}
          onClick={() => onNavigate("integrations")}
        >
          <PlugZap size={17} /> Integrations
        </button>
        <button
          className={view === "settings" ? "nav-active" : ""}
          onClick={() => onNavigate("settings")}
        >
          <Settings2 size={17} /> Project settings
        </button>
      </div>
    </aside>
  );
}

export function Topbar({
  project,
  userEmail,
  onWorkspaceSettings,
  onAccountSettings,
  onSignOut,
}: {
  project: Project | undefined;
  userEmail: string;
  onWorkspaceSettings: () => void;
  onAccountSettings: () => void;
  onSignOut?: () => void | Promise<void>;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const initials = userEmail
    .split("@")[0]!
    .split(/[._-]/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    if (!accountOpen) return;
    const closeAccountMenu = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("pointerdown", closeAccountMenu);
    return () => document.removeEventListener("pointerdown", closeAccountMenu);
  }, [accountOpen]);

  return (
    <header className="topbar">
      <div>
        <span className="crumb">Workspace</span>
        <span className="crumb-separator">/</span>
        <strong>{project?.name ?? "Scry"}</strong>
      </div>
      <div className="top-actions">
        <div className="account-menu" ref={accountMenuRef}>
          <button
            className="avatar-button"
            onClick={() => setAccountOpen((open) => !open)}
            aria-label="Open account menu"
            aria-expanded={accountOpen}
          >
            <span className="avatar">{initials || "SC"}</span>
          </button>
          {accountOpen && (
            <div className="account-popover">
              <div className="account-identity">
                <span>Signed in as</span>
                <strong>{userEmail}</strong>
              </div>
              <div className="account-menu-actions">
                <button
                  onClick={() => {
                    setAccountOpen(false);
                    onWorkspaceSettings();
                  }}
                >
                  <Box size={15} /> Workspace settings
                </button>
                <button
                  onClick={() => {
                    setAccountOpen(false);
                    onAccountSettings();
                  }}
                >
                  <Settings2 size={15} /> Account settings
                </button>
                {onSignOut && (
                  <button className="account-logout" onClick={() => void onSignOut()}>
                    <LogOut size={15} /> Log out
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const project = await post<Project>("/projects", { name, description });
      onCreated(project);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create project"
      subtitle="Create a home for related Flows, runs, and durable test history."
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)} className="stack-form">
        <label>
          <span>Project name</span>
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme staging"
          />
        </label>
        <label>
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Customer-facing product journeys"
          />
        </label>
        {error && (
          <div className="form-error">
            <AlertTriangle size={15} /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-workspace">
      <div className="radar large">
        <span />
        <span />
        <span />
        <Eye size={38} />
      </div>
      <div className="eyebrow lime">WELCOME TO SCRY</div>
      <h1>
        Give every test
        <br />a permanent memory.
      </h1>
      <p>
        Create a project, then build connected Flows with their own related URLs, ordered Sequences,
        and durable browser evidence.
      </p>
      <button className="primary-button" onClick={onCreate}>
        <Plus size={16} /> Create first project
      </button>
    </div>
  );
}
export function BootScreen() {
  return (
    <div className="boot">
      <div className="brand-mark">
        <Eye size={25} />
      </div>
      <div className="boot-line">
        <span />
      </div>
      <small>INITIALIZING TEST COMMAND</small>
    </div>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
