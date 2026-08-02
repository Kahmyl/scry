export type DashboardView =
  | "overview"
  | "missions"
  | "runs"
  | "reports"
  | "settings"
  | "workspace"
  | "account"
  | "integrations";

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
  if (pathname === dashboardPaths.missions || pathname.startsWith(`${dashboardPaths.missions}/`)) return "missions";
  if (pathname === "/dashboard/flows") return "missions";
  if (pathname === dashboardPaths.runs || pathname.startsWith(`${dashboardPaths.runs}/`)) return "runs";
  if (pathname === dashboardPaths.reports || pathname.startsWith(`${dashboardPaths.reports}/`)) return "reports";
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
