import type { ComponentType, ReactNode } from "react";
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
export type ReportCard = {
  id: string;
  missionId: string;
  missionTitle: string;
  summary: string;
  state: string;
  createdAt: string;
  finalizedAt?: string;
};
export type RunCard = {
  id: string;
  flowName: string;
  environmentName: string;
  state: string;
  artifactCount: number;
  completeEvidenceStreams: number;
  createdAt: string;
  updatedAt: string;
};
export type MissionCollectionDesignProps = {
  missions: MissionCard[];
  state: "loading" | "ready" | "error";
  onOpen: (id: string) => void;
  onIntegrations: () => void;
  onRetry: () => void;
};
export type ReportCollectionDesignProps = {
  reports: ReportCard[];
  state: "loading" | "ready" | "error";
  onOpen: (id: string) => void;
  onMissions: () => void;
  onRetry: () => void;
};
export type StatusSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
};
export type StatusSelectComponent = ComponentType<StatusSelectProps>;
export type OverviewProps = {
  missions: MissionCard[];
  runs: RunCard[];
  reportCount: number;
  onMission: (id: string) => void;
  onRun: (id: string) => void;
  onMissions: () => void;
  onRuns: () => void;
  onReports: () => void;
  onIntegrations: () => void;
};
export type RunCollectionProps = {
  runs: RunCard[];
  state: "loading" | "ready" | "error";
  onOpen: (id: string) => void;
  onRetry: () => void;
  onMissions: () => void;
};
export type RunDetailProps = {
  run: RunCard & { flowPurpose: string; baseOrigin: string };
  evidence: ReactNode;
  recordingNotes: string[];
  onBack: () => void;
  onMission?: () => void;
};
