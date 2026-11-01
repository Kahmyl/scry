// Diagnostics must not turn an application's retry loop into unbounded parent
// memory or agent output. Enforcement remains in the proxy; this is reporting.
export class PolicyDiagnostics {
  constructor(limit = 64) {
    this.limit = limit;
    this.entries = new Map();
    this.overflow = 0;
  }
  record({ origin, reason }, at = Date.now()) {
    const key = origin + "\n" + reason;
    const row = this.entries.get(key);
    if (row) {
      row.count++;
      row.lastSeen = at;
    } else if (this.entries.size < this.limit) {
      this.entries.set(key, { origin, reason, count: 1, firstSeen: at, lastSeen: at });
    } else this.overflow++;
  }
  checkpoint() {
    return {
      counts: new Map([...this.entries].map(([k, v]) => [k, v.count])),
      overflow: this.overflow,
    };
  }
  since(checkpoint) {
    const rows = [...this.entries].flatMap(([key, row]) => {
      const count = row.count - (checkpoint.counts.get(key) ?? 0);
      return count ? [{ ...row, count }] : [];
    });
    if (this.overflow > checkpoint.overflow)
      rows.push({ reason: "additional_policy_blocks", count: this.overflow - checkpoint.overflow });
    return rows;
  }
}
