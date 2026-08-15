export type MaybePromise<T> = T | Promise<T>;

export interface AssuranceDescriptor {
  id: string;
  title: string;
  description?: string;
  tags?: readonly string[];
}

export type AssuranceStatus =
  | "pass"
  | "fail"
  | "inconclusive"
  | "skipped"
  | "not_run";

export type AssuranceEvidenceSource =
  | "chronicle"
  | "fixture"
  | "external"
  | "assurance";

export interface AssuranceEvidenceRef {
  source: AssuranceEvidenceSource;
  kind: string;
  ref: string;
  description?: string;
}
