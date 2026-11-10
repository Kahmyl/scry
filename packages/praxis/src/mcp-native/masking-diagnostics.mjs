import { randomUUID } from "node:crypto";
/** Only finite reason codes, opaque page IDs and times cross this boundary. */
export class MaskingDiagnostics {
  constructor(emit) {
    this.emit = emit;
    this.pages = new Map();
  }
  state(page, state, reason) {
    let known = this.pages.get(page);
    if (!known) {
      known = { id: randomUUID() };
      this.pages.set(page, known);
    }
    if (known.state === state && known.reason === reason) return;
    known.state = state;
    known.reason = reason;
    this.emit({ pageId: known.id, at: Date.now(), state, reason });
  }
  degrade(page, reason) {
    if (page?.isClosed?.()) {
      this.forget(page);
      return;
    }
    this.state(page, "degraded", reason);
  }
  recovered(page) {
    if (page?.isClosed?.()) {
      this.forget(page);
      return;
    }
    if (this.pages.get(page)?.state === "degraded")
      this.state(page, "recovered", "refresh_confirmed");
  }
  forget(page) {
    if (this.pages.has(page)) this.state(page, "page_closed", "page_closed");
    this.pages.delete(page);
  }
}
