export type DashboardView =
  | "overview"
  | "missions"
  | "runs"
  | "reports"
  | "settings"
  | "workspace"
  | "account"
  | "integrations";

export const dashboardAuthority = {
  authoringSurface: "mcp",
  retainedHumanControls: [
    "active_run_cancel",
    "calibration_approval",
    "credential_management",
    "mcp_token_management",
    "project_setup",
    "session_revocation",
  ],
  prohibitedDashboardMutations: [
    "mission_authoring",
    "objective_authoring",
    "flow_authoring",
    "execution_plan_authoring",
    "run_start",
    "run_rerun",
  ],
} as const;

export const dashboardPaths: Record<DashboardView, string> = {
  overview: "/dashboard",
  missions: "/dashboard/missions",
  runs: "/dashboard/runs",
  reports: "/dashboard/reports",
  settings: "/dashboard/settings",
  workspace: "/dashboard/workspace",
  account: "/dashboard/account",
  integrations: "/dashboard/integrations",
};

export function resolveDashboardView(pathname: string): DashboardView {
  if (pathname === dashboardPaths.overview) return "overview";
  if (pathname === dashboardPaths.missions || pathname.startsWith(`${dashboardPaths.missions}/`))
    return "missions";
  if (pathname === "/dashboard/flows") return "missions";
  if (pathname === dashboardPaths.runs || pathname.startsWith(`${dashboardPaths.runs}/`))
    return "runs";
  if (pathname === dashboardPaths.reports || pathname.startsWith(`${dashboardPaths.reports}/`))
    return "reports";
  if (pathname === dashboardPaths.settings) return "settings";
  if (pathname === dashboardPaths.workspace) return "workspace";
  if (pathname === dashboardPaths.account) return "account";
  if (pathname === dashboardPaths.integrations) return "integrations";
  return "overview";
}

export function reconcileProjectSelection(
  projects: Array<{ id: string }>,
  selectedProjectId: string,
): string {
  if (projects.some((project) => project.id === selectedProjectId)) return selectedProjectId;
  return projects[0]?.id ?? "";
}

export function veilPolicyIdentity(policyDigest: string) {
  if (!/^[a-f0-9]{64}$/.test(policyDigest)) throw new Error("VEIL_POLICY_DIGEST_INVALID");
  return policyDigest.slice(0, 12);
}
