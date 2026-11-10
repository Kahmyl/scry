import { randomUUID, createHash } from "node:crypto";
/** Files remain private browser scratch. Only bounded completion facts enter
 * evidence; receipt IDs are Session-local, never filesystem paths. */
export class DownloadTracker {
  constructor(clean, { maxBytes = 16 * 1024 * 1024, limit = 20 } = {}) {
    this.clean = clean;
    this.maxBytes = maxBytes;
    this.limit = limit;
    this.items = new Map();
    this.closed = false;
    this.rejected = 0;
    this.network = new Map();
    this.capacityCancellationRequests = 0;
  }
  progress(event, cancel) {
    if (!event || typeof event.guid !== "string" || event.guid.length > 100) return;
    let current = this.network.get(event.guid);
    if (!current) {
      if (this.network.size >= 40) {
        void cancel(event.guid).catch(() => {});
        return;
      }
      current = { started: Date.now(), cancelled: false };
      this.network.set(event.guid, current);
    }
    if (
      !current.cancelled &&
      (event.receivedBytes > this.maxBytes ||
        event.totalBytes > this.maxBytes ||
        Date.now() - current.started > 30000)
    ) {
      current.cancelled = true;
      this.capacityCancellationRequests++;
      void cancel(event.guid).catch(() => {});
    }
    if (["completed", "canceled"].includes(event.state)) this.network.delete(event.guid);
  }
  attach(page) {
    page.on("download", (download) => this.capture(download));
  }
  capture(download) {
    if (
      this.closed ||
      this.items.size >= this.limit ||
      [...this.items.values()].filter((i) => i.state === "pending").length >= 2
    ) {
      this.rejected++;
      void download.cancel().catch(() => {});
      return;
    }
    const item = { id: randomUUID(), state: "pending", startedAt: Date.now(), download };
    this.items.set(item.id, item);
    item.done = (async () => {
      const timeout = setTimeout(() => {
        if (item.state === "pending") {
          item.state = "timed_out";
          void download.cancel().catch(() => {});
        }
      }, 30000);
      try {
        const stream = await download.createReadStream();
        if (!stream) throw Error("download_unavailable");
        const hash = createHash("sha256"),
          chunks = [];
        let bytes = 0,
          head = Buffer.alloc(0);
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > this.maxBytes) {
            stream.destroy();
            item.state = "oversized";
            await download.cancel().catch(() => {});
            return;
          }
          hash.update(chunk);
          chunks.push(chunk);
          if (head.length < 256) head = Buffer.concat([head, chunk.subarray(0, 256 - head.length)]);
        }
        if (await download.failure()) throw Error("download_interrupted");
        // Timeout/closure is an authoritative observation. Cancellation can
        // settle late; those bytes must never upgrade it to verified success.
        if (item.state !== "pending" || this.closed) return;
        const digest = hash.digest("hex");
        let format =
          head.subarray(0, 5).toString() === "%PDF-"
            ? "pdf"
            : head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              ? "png"
              : head.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
                ? "zip"
                : "unknown";
        if (format === "unknown")
          try {
            JSON.parse(Buffer.concat(chunks).toString("utf8"));
            format = "json";
          } catch {
            /* Unknown format is a fact, never a guessed successful check. */
          }
        item.state = "completed";
        item.bytes = bytes;
        item.sha256 = digest;
        item.format = format;
        item.fileName = this.clean(download.suggestedFilename()).slice(0, 200);
        item.completedAt = Date.now();
      } catch {
        if (item.state === "pending") item.state = "interrupted";
      } finally {
        clearTimeout(timeout);
        await download.delete().catch(() => {});
      }
    })();
  }
  list() {
    return [...this.items.values()].map(({ done, download, ...safe }) => structuredClone(safe));
  }
  async wait(id, milliseconds) {
    const item = this.items.get(id);
    if (!item || item.state !== "pending" || milliseconds <= 0) return;
    let timer;
    try {
      await Promise.race([
        item.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  verify(id, expected) {
    const item = this.list().find((x) => x.id === id);
    if (!item) return { state: "not_found", verified: false };
    const mismatches = [];
    if (item.state !== "completed")
      return { ...item, verified: false, reason: "completion_unconfirmed" };
    if (item.bytes < expected.minBytes || item.bytes > expected.maxBytes) mismatches.push("size");
    if (expected.sha256 && item.sha256 !== expected.sha256) mismatches.push("sha256");
    if (expected.fileName && item.fileName !== expected.fileName) mismatches.push("filename");
    if (expected.format !== "any" && item.format !== expected.format) mismatches.push("format");
    return { ...item, verified: mismatches.length === 0, mismatches };
  }
  async close() {
    this.closed = true;
    const pending = [...this.items.values()].filter((i) => i.state === "pending");
    for (const item of pending) item.state = "interrupted";
    await Promise.allSettled(pending.map((i) => i.download.cancel()));
    await Promise.allSettled([...this.items.values()].map((i) => i.done));
  }
}
