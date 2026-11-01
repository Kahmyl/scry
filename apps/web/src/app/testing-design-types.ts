import type { ReactNode } from "react";

export type EvidenceRef = { runId: string; artifactId?: string };
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
  evidence: ReactNode;
  evidenceRequested: boolean;
};
export type ReportContentDesignProps = {
  content: ReportContent;
  onEvidence: (ref: EvidenceRef) => void;
};

/* Existing media DOM that your page can style under its own namespace:
 section.panel.native-evidence[aria-label="Run recordings and screenshots"]
 h3 "Recordings and screenshots", refresh button,
 p.native-evidence-warning (MUST remain visible), optional p[role=alert/status],
 label.native-evidence-mobile > select[aria-label="Choose evidence"],
 div.native-evidence-layout >
   div.native-evidence-selector[role=group][aria-label="Select evidence"] >
     button[aria-pressed] with title and small kind/time,
   div.native-evidence-viewer[aria-live=polite] > h4, description,
     video[controls][playsinline] OR figure > img,
     label > select[aria-label="Playback speed"] and timing/partial-coverage note.
 The onEvidence(ref) callback selects an exact item; never substitute another one.
 */
