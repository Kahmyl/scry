import type { ReactNode } from "react";

export type EvidenceRef = { runId: string; artifactId?: string };
/** Presentation context only; never changes the exact evidence reference. */
export type ReportEvidenceContext = {
  title: string;
  section:
    | "checks"
    | "checks-expected"
    | "checks-different"
    | "checks-uncertain"
    | "checks-not-tested"
    | "observations";
  elementId: string;
};
export type EvidenceLink = { runId: string; artifactId: string };
export type MissionCard = {
  id: string;
  title: string;
  originalInstruction: string;
  state: string;
  objectiveCount: number;
  terminalObjectiveCount: number;
  updatedAt: string;
  createdAt?: string;
  finalReportId?: string;
};
export type MissionData = {
  id: string;
  title: string;
  instruction: string;
  state: string;
  objectives: Array<{ id: string; title: string; description: string; state: string }>;
  flows: Array<{ id: string; name: string; purpose: string; state: string; revision: number }>;
  runs: Array<{ id: string; flowId: string; objectiveId: string; state: string }>;
};
export type ReportCard = {
  id: string;
  missionId: string;
  missionTitle: string;
  summary: string;
  state: string;
  createdAt: string;
  finalizedAt?: string;
};
export type ReportContent = {
  sections?: Array<{ title: string; items: Array<{ title: string; detail: string }> }>;
  scope: string[];
  verified: string[];
  limitations: string[];
  checks: Array<{
    title: string;
    actual: string;
    expected?: string | undefined;
    label: string;
    evidence: EvidenceLink[];
  }>;
  observations: Array<{
    title: string;
    detail: string;
    suggestion?: string;
    evidence: EvidenceLink[];
  }>;
};
export type ReportData = ReportCard & {
  originalInstruction?: string;
  evidenceCoverage?: {
    runs: number;
    complete: number;
    incomplete: number;
    open: number;
    missing: number;
    unavailable?: number;
  };
};
export type MissionCollectionDesignProps = {
  missions: MissionCard[];
  state: "loading" | "ready" | "error";
  onOpen: (id: string) => void;
  onIntegrations: () => void;
  onRetry: () => void;
};
export type MissionDetailDesignProps = {
  mission: MissionData;
  onBack: () => void;
  onReport?: () => void;
  journeys: ReactNode;
};
export type JourneyEvidenceDesignProps = {
  journeys: Array<{
    id: string;
    name: string;
    purpose: string;
    attempts: Array<{ id: string; progress: string }>;
  }>;
  selectedRunId?: string;
  /** Stable across polling; a new explicit request must restore its exact evidence view. */
  selectionRequest?: EvidenceRef;
  onSelect: (id: string) => void;
  findingContext?: ReactNode;
  evidence: ReactNode;
};
export type ReportCollectionDesignProps = {
  reports: ReportCard[];
  state: "loading" | "ready" | "error";
  onOpen: (id: string) => void;
  onMissions: () => void;
  onRetry: () => void;
};
export type ReportDetailDesignProps = {
  report: ReportData;
  content: ReportContent;
  onBack: () => void;
  onMission: () => void;
  onEvidence: (ref: EvidenceRef) => void;
  evidence: ReactNode | ((findingContext: ReactNode) => ReactNode);
  evidenceRequested: boolean;
};
export type ReportContentDesignProps = {
  content: ReportContent;
  onEvidence: (ref: EvidenceRef, context?: ReportEvidenceContext) => void;
};

/* Evidence renders the original protected media, never a reconstructed page.
 * Its warning remains visible. Only the selected authorized item is fetched.
 * onEvidence(ref) selects an exact item; never silently substitute another one. */
