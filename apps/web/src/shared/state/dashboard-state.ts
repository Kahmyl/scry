export type DashboardView =
  | "overview"
  | "missions"
  | "runs"
  | "reports"
  | "operations"
  | "settings"
  | "workspace"
  | "account"
  | "integrations";

export function reconcileProjectSelection(
  projects: Array<{ id: string }>,
  selectedProjectId: string,
): string {
  if (projects.some((project) => project.id === selectedProjectId)) return selectedProjectId;
  return projects[0]?.id ?? "";
}
