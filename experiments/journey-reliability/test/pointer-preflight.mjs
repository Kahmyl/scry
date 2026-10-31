// Lab-only native hover plus read-only geometry/hit-test confirmation. Not an
// assertion of business readiness, and not a substitute for action postconditions.
export async function preparePointer(locator, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs && attempts++ < 3) {
    await locator.hover({ timeout: Math.max(1, timeoutMs - (Date.now() - start)) });
    let timer;
    const state = await Promise.race([
      locator.evaluate(async (e) => {
        const rect = () => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        };
        const before = rect();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const after = rect(),
          root = e.getRootNode();
        const hit = root.elementFromPoint?.(after[0] + after[2] / 2, after[1] + after[3] / 2);
        return {
          connected: e.isConnected,
          stable: before.every((n, i) => Math.abs(n - after[i]) < 0.5),
          targetAtPoint: hit === e || e.contains(hit),
        };
      }),
      new Promise((r) => {
        timer = setTimeout(() => r(null), Math.max(1, timeoutMs - (Date.now() - start)));
      }),
    ]);
    clearTimeout(timer);
    // A late read has no input side effects and is discarded, not admitted as
    // current evidence. Action execution is never abandoned this way.
    if (!state) return { ready: false, attempts, elapsedMs: Date.now() - start };
    if (state.connected && state.stable && state.targetAtPoint)
      return { ready: true, attempts, elapsedMs: Date.now() - start };
  }
  return { ready: false, attempts, elapsedMs: Date.now() - start };
}
