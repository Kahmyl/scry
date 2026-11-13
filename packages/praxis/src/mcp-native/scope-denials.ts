/** Bounded observations from the existing scope proxy, independent of its policy.
 * Veil owns diagnostic privacy. Praxis validates only structural canonical form.
 */
export const DENIAL_LIMITS = Object.freeze({ capacity: 8, maxCapacity: 8, endpointChars: 512 });
export type DiagnosticCleaner = (value: string) => unknown;
type Transport = "http_origin" | "connect_endpoint" | "unknown";
type Admission = "canonical" | "malformed" | "oversized" | "unsupported";
type Observation = Readonly<{
  sequence: number;
  denied: boolean;
  transport: Transport;
  admission: Admission;
  endpoint?: string;
}>;
type Unavailable =
  Admission | "cleaner_missing" | "cleaner_failed" | "cleaner_output_invalid" | "display_redacted";

// Private fields keep cursors session-specific and prevent caller-edited counters.
class Cursor {
  #owner: object;
  #sequence: number;
  #denials: number;
  constructor(owner: object, sequence: number, denials: number) {
    this.#owner = owner;
    this.#sequence = sequence;
    this.#denials = denials;
  }
  static read(value: unknown, owner: object): { sequence: number; denials: number } | undefined {
    try {
      if (!(value instanceof Cursor) || value.#owner !== owner) return;
      return { sequence: value.#sequence, denials: value.#denials };
    } catch {
      return;
    }
  }
}
export type DenialCursor = Cursor;

export type DenialSnapshot = Readonly<{
  cursor: DenialCursor;
  lifecycle: "active" | "disposed";
  window: "session_to_snapshot" | "cursor_to_snapshot";
  cursorStatus: "not_requested" | "valid" | "invalid";
  // Counts are lower bounds once the finite sequence counter is exhausted.
  countsExact: boolean;
  observedCallbackCount: number;
  denialCount: number;
  retainedCallbackCount: number;
  droppedCallbackCount: number;
  droppedDenialCount: number;
  detailUnavailableCount: number;
  unavailableReasons: readonly Unavailable[];
  endpoints: readonly Readonly<{
    transport: "http_origin" | "connect_endpoint";
    endpoint: string;
    count: number;
  }>[];
  scopeRestrictionObserved: boolean;
  interpretation: "contextual_observation_only";
  applicationConclusion: "not_determined";
  actionDispatch: "not_determined";
  causalAssociation: "not_established";
}>;

/** Exact canonical origin/authority admission is structural, not a privacy rule.
 * CONNECT is opaque TCP (including WebSocket): no HTTPS origin or permission can
 * be inferred. The existing callback's unbracketed IPv6 form is ambiguous and is
 * therefore count-only, rather than guessed into a destination.
 */
function admit(value: unknown): Pick<Observation, "transport" | "admission" | "endpoint"> {
  if (typeof value !== "string") return { transport: "unknown", admission: "malformed" };
  const transport: Transport = value.startsWith("tunnel://")
    ? "connect_endpoint"
    : value.startsWith("http://") || value.startsWith("https://")
      ? "http_origin"
      : "unknown";
  if (value.length > DENIAL_LIMITS.endpointChars) return { transport, admission: "oversized" };
  try {
    if (transport === "http_origin") {
      const url = new URL(value);
      if (!url.username && !url.password && url.origin === value)
        return { transport, admission: "canonical", endpoint: value };
    } else if (transport === "connect_endpoint") {
      const authority = value.slice("tunnel://".length);
      const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+):([1-9][0-9]{0,4})$/.exec(authority);
      if (match && Number(match[2]) <= 65535) {
        const url = new URL(`http://${authority}`);
        if (!url.username && !url.password && `${url.hostname}:${Number(match[2])}` === authority)
          return { transport, admission: "canonical", endpoint: authority };
      }
    }
  } catch {
    // Never retain or emit parser errors, which can contain the raw input.
  }
  return { transport, admission: transport === "unknown" ? "unsupported" : "malformed" };
}

/** One instance per native browser session; no global registry or endpoint map.
 * record and snapshot are synchronous/atomic on the JS event loop. The cleaner
 * must be synchronous (as Veil protector.clean is); promises are invalid output.
 * Each snapshot observes prior callbacks or callbacks since a cursor. Temporal
 * overlap does not establish that a command caused a denial, failed, or was not
 * dispatched. Snapshotting does not consume observations.
 */
export function createSessionDenials(
  options: { capacity?: number; clean?: DiagnosticCleaner } = {},
) {
  const capacity = options.capacity ?? DENIAL_LIMITS.capacity;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > DENIAL_LIMITS.maxCapacity)
    throw new RangeError("INVALID_DENIAL_CAPACITY");
  let clean = options.clean;
  const ring: (Observation | undefined)[] = new Array(capacity);
  let owner = {};
  let sequence = 0;
  let denials = 0;
  let retained = 0;
  let next = 0;
  let exact = true;
  let disposed = false;

  const cursor = (): DenialCursor => {
    const token = new Cursor(owner, sequence, denials);
    Object.freeze(token);
    return token;
  };
  const record = (event: unknown): void => {
    if (disposed) return;
    if (sequence === Number.MAX_SAFE_INTEGER) {
      exact = false;
      return;
    }
    sequence += 1;
    let observation: Observation = {
      sequence,
      denied: false,
      transport: "unknown",
      admission: "malformed",
    };
    try {
      if (event && typeof event === "object" && !Array.isArray(event)) {
        const candidate = event as Record<string, unknown>;
        if (candidate.reason === "origin_not_allowed") {
          denials += 1;
          observation = { ...observation, denied: true };
          observation = { sequence, denied: true, ...admit(candidate.origin) };
        }
      }
    } catch {
      // Accessor/proxy exceptions remain count-only; never stringify the event.
    }
    ring[next] = observation;
    next = (next + 1) % capacity;
    retained = Math.min(retained + 1, capacity);
  };

  const snapshot = (since?: DenialCursor, through?: DenialCursor): DenialSnapshot => {
    const end = Cursor.read(through, owner);
    const upper = end && end.sequence <= sequence ? end : { sequence, denials };
    const start = Cursor.read(since, owner);
    const valid = start && start.sequence <= upper.sequence && start.denials <= upper.denials;
    const after = valid ? start.sequence : 0;
    const observedCallbackCount = upper.sequence - after;
    const denialCount = upper.denials - (valid ? start.denials : 0);
    const current = through && end ? through : cursor();
    // Copy before invoking external code; a cleaner may reenter record/clear.
    const captured: Observation[] = [];
    for (let i = 0; i < retained; i++) {
      const item = ring[(next - retained + i + capacity) % capacity];
      if (item && item.sequence > after && item.sequence <= upper.sequence) captured.push(item);
    }
    const countsExact = exact;
    const lifecycle = disposed ? "disposed" : "active";
    let retainedDenials = 0;
    let detailUnavailableCount = 0;
    const unavailable = new Set<Unavailable>();
    const endpoints = new Map<
      string,
      { transport: "http_origin" | "connect_endpoint"; endpoint: string; count: number }
    >();
    for (const item of captured) {
      if (!item.denied) continue;
      retainedDenials += 1;
      let issue: Unavailable | undefined;
      if (!item.endpoint || item.transport === "unknown") issue = item.admission;
      else if (typeof clean !== "function") issue = "cleaner_missing";
      else {
        try {
          const display = clean(item.endpoint);
          // Unknown outputs and changed/redacted displays never become endpoints.
          // This also prevents a cleaner from injecting a new URL or extra text.
          if (typeof display !== "string") {
            // The port is synchronous. Retire native Promise rejections without
            // awaiting them or executing arbitrary thenables as diagnostics.
            if (display instanceof Promise)
              void Promise.prototype.then.call(display, undefined, () => undefined);
            issue = "cleaner_output_invalid";
          } else if (display !== item.endpoint) issue = "display_redacted";
          else {
            const key = `${item.transport}:${display}`;
            const aggregate = endpoints.get(key);
            if (aggregate) aggregate.count += 1;
            else endpoints.set(key, { transport: item.transport, endpoint: display, count: 1 });
          }
        } catch {
          issue = "cleaner_failed";
        }
      }
      if (issue) {
        detailUnavailableCount += 1;
        unavailable.add(issue);
      }
    }
    return Object.freeze({
      cursor: current,
      lifecycle,
      window: valid ? "cursor_to_snapshot" : "session_to_snapshot",
      cursorStatus: since === undefined ? "not_requested" : valid ? "valid" : "invalid",
      countsExact,
      observedCallbackCount,
      denialCount,
      retainedCallbackCount: captured.length,
      droppedCallbackCount: observedCallbackCount - captured.length,
      droppedDenialCount: denialCount - retainedDenials,
      detailUnavailableCount,
      unavailableReasons: Object.freeze([...unavailable]),
      endpoints: Object.freeze([...endpoints.values()].map((item) => Object.freeze(item))),
      scopeRestrictionObserved: denialCount > 0,
      interpretation: "contextual_observation_only",
      applicationConclusion: "not_determined",
      actionDispatch: "not_determined",
      causalAssociation: "not_established",
    });
  };
  const clear = (): void => {
    ring.fill(undefined);
    owner = {};
    sequence = denials = retained = next = 0;
    exact = true;
  };
  return Object.freeze({
    record,
    snapshot,
    cursor,
    clear,
    setCleaner(value: DiagnosticCleaner | undefined): void {
      if (!disposed) clean = value;
    },
    dispose(): void {
      clear();
      clean = undefined;
      disposed = true;
    },
  });
}
