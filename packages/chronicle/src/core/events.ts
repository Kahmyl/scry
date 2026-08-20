export type ChronicleCorrelation = Readonly<{
  projectId?: string;
  missionId?: string;
  flowId?: string;
  runId?: string;
  attemptId?: string;
  sessionId?: string;
  pageId?: string;
  documentId?: string;
  operationId?: string;
}>;

export type ChronicleEvent = Readonly<{
  /**
   * Factual event name.
   *
   * Chronicle deliberately does not define a large closed ontology yet.
   * Event vocabulary should grow from actual runtime requirements.
   */
  type: string;

  occurredAt: string;

  correlation?: ChronicleCorrelation;

  payload?: Readonly<Record<string, unknown>>;

  artifactRefs?: readonly string[];
}>;

export interface ChronicleSink {
  append(event: ChronicleEvent): Promise<void>;
}

export function chronicleEvent(event: ChronicleEvent): ChronicleEvent {
  const type = event.type.trim();

  if (!type) {
    throw new Error("CHRONICLE_EVENT_TYPE_REQUIRED");
  }

  const timestamp = new Date(event.occurredAt);

  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("CHRONICLE_EVENT_TIME_INVALID");
  }

  return Object.freeze({
    type,

    occurredAt: event.occurredAt,

    ...(event.correlation
      ? {
          correlation: Object.freeze({
            ...event.correlation,
          }),
        }
      : {}),

    ...(event.payload
      ? {
          payload: Object.freeze({
            ...event.payload,
          }),
        }
      : {}),

    ...(event.artifactRefs
      ? {
          artifactRefs: Object.freeze([...event.artifactRefs]),
        }
      : {}),
  });
}
