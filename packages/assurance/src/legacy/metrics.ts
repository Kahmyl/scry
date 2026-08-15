import type { CampaignMetrics } from "@scry/contracts";

type Sample = { operationId: string; phase: string; durationMs: number };
type Measurement = CampaignMetrics["measurements"][number];
type Observation = Pick<Measurement, "source" | "eventId">;

export class CampaignMetricsCollector {
  private readonly startedAt = performance.now();
  private readonly samples: Sample[] = [];
  private readonly retries = new Map<string, number>();
  private decisionBoundaries = 0;
  private mcpRequests = 0;
  private apiRequests = 0;
  private idleMs = 0;
  private bytesReturned = 0;
  private unchangedReads = 0;
  private readonly measurements: Measurement[] = [];

  constructor(private readonly correlationId: string) {}

  async phase<T>(
    operationId: string,
    phase: string,
    observation: Observation,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      this.record(operationId, phase, performance.now() - startedAt, observation);
    }
  }

  record(operationId: string, phase: string, durationMs: number, observation: Observation): void {
    this.samples.push({ operationId, phase, durationMs: Math.max(0, durationMs) });
    this.measurements.push({
      metric: `phase:${phase}`,
      operationId,
      ...observation,
      correlationId: this.correlationId,
      value: Math.max(0, durationMs),
    });
  }

  countDecisionBoundary(observation: Observation, count = 1): void {
    this.decisionBoundaries += count;
    this.count("agentDecisionBoundaries", observation, count);
  }

  countMcpRequest(observation: Observation, count = 1): void {
    this.mcpRequests += count;
    this.count("mcpRequests", observation, count);
  }

  countApiRequest(observation: Observation, count = 1): void {
    this.apiRequests += count;
    this.count("apiRequests", observation, count);
  }

  countIdle(durationMs: number, observation: Observation): void {
    this.idleMs += Math.max(0, durationMs);
    this.count("modelClientIdleMs", observation, durationMs);
  }

  countBytesReturned(bytes: number, observation: Observation): void {
    this.bytesReturned += Math.max(0, Math.floor(bytes));
    this.count("bytesReturnedToAgent", observation, bytes);
  }

  countUnchangedStateRead(observation: Observation, count = 1): void {
    this.unchangedReads += count;
    this.count("unchangedStateReads", observation, count);
  }

  countRetry(reasonCode: string, observation: Observation): void {
    this.retries.set(reasonCode, (this.retries.get(reasonCode) ?? 0) + 1);
    this.count(`retry:${reasonCode}`, observation, 1);
  }

  snapshot(totalWallClockMs = performance.now() - this.startedAt): CampaignMetrics {
    const groups = new Map<string, number[]>();
    for (const sample of this.samples) {
      const values = groups.get(sample.phase) ?? [];
      values.push(sample.durationMs);
      groups.set(sample.phase, values);
    }
    return {
      totalWallClockMs: Math.max(0, totalWallClockMs),
      agentDecisionBoundaries: this.decisionBoundaries,
      mcpRequests: this.mcpRequests,
      apiRequests: this.apiRequests,
      modelClientIdleMs: this.idleMs,
      bytesReturnedToAgent: this.bytesReturned,
      unchangedStateReads: this.unchangedReads,
      retriesByReason: Object.fromEntries(
        [...this.retries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      phases: Object.fromEntries(
        [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([phase, values]) => [phase, distribution(values)]),
      ),
      slowestOperations: [...this.samples]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 20),
      measurements: [...this.measurements],
    };
  }

  private count(metric: string, observation: Observation, value: number) {
    this.measurements.push({
      metric,
      operationId: observation.eventId,
      ...observation,
      correlationId: this.correlationId,
      value: Math.max(0, value),
    });
  }
}

function distribution(input: number[]) {
  const values = [...input].sort((a, b) => a - b);
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.at(-1) ?? 0,
  };
}

function percentile(values: number[], value: number): number {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)] ?? 0;
}
