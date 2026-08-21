export interface AssuranceMetric {
  name: string;
  value: number;
  unit?: string;
  operationId?: string;
}

/**
 * Metrics are observations.
 *
 * They do not carry pass/fail semantics by themselves.
 *
 * A separate explicit verification may assert a real
 * performance or operational requirement.
 */
export function metric(value: AssuranceMetric): AssuranceMetric {
  return value;
}
