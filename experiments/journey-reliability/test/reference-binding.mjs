// Use the exact aria-ref locator mechanism used by the pinned official MCP
// resolver, not an app/framework locator conversion or a competing ref registry.
export class DocumentBindings {
  #epochs = new WeakMap();
  #installed = new WeakSet();
  constructor(context) {
    for (const page of context.pages()) this.install(page);
    context.on("page", (page) => this.install(page));
  }
  install(page) {
    if (this.#installed.has(page)) return;
    this.#installed.add(page);
    page.on("framenavigated", (frame) =>
      this.#epochs.set(frame, (this.#epochs.get(frame) ?? 0) + 1),
    );
  }
  async bind(page, reference) {
    if (!/^(f\d+)?e\d+$/.test(reference)) throw Error("INVALID_NATIVE_REFERENCE");
    const selector = "aria-ref=" + reference,
      locator = page.locator(selector);
    const handle = await locator.elementHandle({ timeout: 1000 });
    if (!handle) throw Error("REFERENCE_UNAVAILABLE");
    const frame = await handle.ownerFrame();
    if (!frame) {
      await handle.dispose();
      throw Error("REFERENCE_DOCUMENT_UNAVAILABLE");
    }
    const epoch = this.#epochs.get(frame) ?? 0;
    return {
      selector,
      locator,
      handle,
      valid: async () =>
        !page.isClosed() &&
        !frame.isDetached() &&
        (this.#epochs.get(frame) ?? 0) === epoch &&
        (await handle.evaluate((e) => e.isConnected).catch(() => false)),
      dispose: () => handle.dispose(),
    };
  }
}
