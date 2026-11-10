import { readFileSync } from "node:fs";

// Fixed worker-owned asset, never an agent-provided script or expression. It
// avoids transpiler closures when Playwright serializes browser callbacks.
const factory = Function(
  "return (" +
    readFileSync(new URL("./observation-guard.browser.js", import.meta.url), "utf8")
      .trim()
      .replace(/;$/, "") +
    ");",
)();
const active = new WeakMap();
const observationFactory = Function(
  "return (" +
    readFileSync(new URL("./observation-state.browser.js", import.meta.url), "utf8")
      .trim()
      .replace(/;$/, "") +
    ");",
)();

export async function observeControlState(page) {
  const guards = [],
    context = page.context();
  let invalid = false,
    disposed = false;
  const changed = () => {
    invalid = true;
  };
  const onClose = () => {
    void dispose();
  };
  context.on("page", changed);
  page.on("framenavigated", changed);
  page.on("frameattached", changed);
  page.on("framedetached", changed);
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    page.off("close", onClose);
    context.off("page", changed);
    page.off("framenavigated", changed);
    page.off("frameattached", changed);
    page.off("framedetached", changed);
    await Promise.allSettled(
      guards.map(async (g) => {
        await g.evaluate((v) => v.dispose()).catch(() => {});
        await g.dispose().catch(() => {});
      }),
    );
  };
  page.once("close", onClose);
  try {
    for (const frame of page.frames()) guards.push(await frame.evaluateHandle(observationFactory));
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    async valid() {
      return (
        !disposed &&
        !invalid &&
        !page.isClosed() &&
        (
          await Promise.all(guards.map((g) => g.evaluate((v) => v.check()).catch(() => false)))
        ).every(Boolean)
      );
    },
    dispose,
  };
}

/** Bind native aria references to their original handles and observed meaning.
 * Guards complement the origin proxy/custodian; page JS is not an authority. */
export async function bindKnownControls(page, steps, resolve) {
  await active.get(page)?.();
  const url = page.url(),
    pages = new Set(page.context().pages()),
    bindings = [];
  let invalid = false,
    disposed = false;
  const onPage = (p) => {
    if (!pages.has(p)) invalid = true;
  };
  const onNavigation = () => {
    invalid = true;
  };
  const onClose = () => {
    void dispose();
  };
  async function dispose() {
    if (disposed) return;
    disposed = true;
    page.context().off("page", onPage);
    page.off("framenavigated", onNavigation);
    page.off("close", onClose);
    if (active.get(page) === dispose) active.delete(page);
    await Promise.allSettled(
      bindings.map(async ({ handle, guard }) => {
        await guard?.evaluate((g) => g.dispose()).catch(() => {});
        await guard?.dispose().catch(() => {});
        await handle.dispose().catch(() => {});
      }),
    );
    bindings.length = 0;
  }
  active.set(page, dispose);
  page.context().on("page", onPage);
  page.on("framenavigated", onNavigation);
  page.once("close", onClose);
  try {
    for (const step of steps) {
      const { handle } = await resolve(page, step.args.target);
      const binding = { handle, guard: undefined };
      bindings.push(binding);
      binding.guard = await handle.evaluateHandle(factory);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    async before(index, focused = false) {
      if (disposed || invalid || page.url() !== url || !bindings[index])
        throw Error("OBSERVATION_INVALIDATED");
      const b = bindings[index];
      if (!(await b.guard.evaluate((g) => g.check()).catch(() => false)))
        throw Error("OBSERVATION_INVALIDATED");
      if (
        focused &&
        !(await b.handle
          .evaluate((e) => {
            let a = e.ownerDocument.activeElement;
            while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
            return a === e || e.contains(a);
          })
          .catch(() => false))
      )
        throw Error("OBSERVATION_INVALIDATED");
    },
    async after(index) {
      if (
        disposed ||
        (await bindings[index].guard.evaluate((g) => g.wasBlocked()).catch(() => false))
      )
        throw Error("OBSERVATION_INVALIDATED");
    },
    dispose,
  };
}
