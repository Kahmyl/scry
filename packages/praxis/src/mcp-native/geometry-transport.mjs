import { randomUUID } from "node:crypto";

// Private, graph-selected geometry transport. It must never discover candidates,
// inspect text, or emit protocol descriptions outside this worker.
const unsupported = "native_protection_geometry_unsupported";
const stale = "native_protection_geometry_stale";
const capacity = "native_protection_graph_capacity";
const reasons = new Set([unsupported, stale, capacity]);
const failures = new WeakSet();
const maxCoordinate = 1_000_000;
const tolerance = 0.02;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const coordinate = (value) => Number.isFinite(value) && Math.abs(value) <= maxCoordinate;
const near = (a, b) => Math.abs(a - b) <= tolerance;
const sameScope = (a, b) =>
  record(a) &&
  identifier(a.instanceId) &&
  identifier(a.graphId) &&
  a.instanceId === b?.instanceId &&
  a.graphId === b?.graphId;
const refusal = (reason = unsupported) => {
  const result = { reason: reasons.has(reason) ? reason : unsupported };
  failures.add(result);
  return result;
};
const boxValid = (box) =>
  record(box) &&
  [box.left, box.top, box.width, box.height].every(coordinate) &&
  box.width > 0 &&
  box.height > 0 &&
  coordinate(box.left + box.width) &&
  coordinate(box.top + box.height);
const quadValid = (quad) =>
  Array.isArray(quad) &&
  quad.length === 8 &&
  quad.every(coordinate) &&
  near(quad[1], quad[3]) &&
  near(quad[2], quad[4]) &&
  near(quad[5], quad[7]) &&
  near(quad[0], quad[6]) &&
  quad[2] > quad[0] &&
  quad[5] > quad[1];

/** No protocol params, DOM values, or thrown provider text escape this function. */
export async function transportNativeGeometry({
  session,
  contextId,
  frameId,
  isMainFrame,
  readId,
  policyGeneration,
  expectedScope,
  deadline,
  isCurrent,
  signal,
}) {
  const objectGroup = "scry-native-geometry-" + randomUUID();
  let ticket,
    failedReason = stale,
    closed = false,
    accepted = false,
    requests = 0,
    quads = 0;
  const owned = new Set();
  const release = (method, params) => {
    try {
      void Promise.resolve(session.send(method, params)).catch(() => {});
    } catch {
      /* Cleanup errors are private and cannot admit an image. */
    }
  };
  const current = () => {
    try {
      return !signal?.aborted && Date.now() < deadline && isCurrent();
    } catch {
      return false;
    }
  };
  const fence = () => {
    if (!current()) throw refusal(stale);
  };
  const send = async (method, params, owner = false) => {
    fence();
    let timer, aborted;
    const operation = Promise.resolve().then(() => {
      fence();
      return session.send(method, params);
    });
    if (owner) {
      // A reply may arrive after the attempt's group was released. Clean up
      // exactly that old remote object, never another attempt's object group.
      void operation.then(
        (reply) => {
          const id = reply?.result?.objectId;
          if (typeof id !== "string") return;
          if (closed) release("Runtime.releaseObject", { objectId: id });
          else owned.add(id);
        },
        () => {},
      );
    }
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(refusal(stale)), Math.max(0, deadline - Date.now()));
        if (signal) {
          aborted = () => reject(refusal(stale));
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }
      });
      const reply = await Promise.race([operation, timeout]);
      fence();
      return reply;
    } finally {
      clearTimeout(timer);
      if (aborted) signal.removeEventListener("abort", aborted);
    }
  };
  const evaluate = (expression, byValue = true) =>
    send(
      "Runtime.evaluate",
      {
        contextId,
        expression,
        returnByValue: byValue,
        awaitPromise: false,
        objectGroup,
      },
      !byValue,
    );
  const expression = (method, ...args) =>
    `globalThis.__scryNativeGraph?.${method}(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
  try {
    if (
      !Number.isSafeInteger(contextId) ||
      contextId <= 0 ||
      !identifier(frameId) ||
      typeof isMainFrame !== "boolean" ||
      !integer(readId) ||
      !integer(policyGeneration) ||
      !Number.isFinite(deadline) ||
      !sameScope(expectedScope, expectedScope)
    )
      throw refusal();
    const reply = await evaluate(
      expression("geometryRequest", readId, Math.max(0, deadline - Date.now()), expectedScope),
    );
    if (reply?.exceptionDetails) throw refusal();
    const candidate = reply?.result?.value;
    if (record(candidate) && "reason" in candidate) throw refusal(candidate.reason);
    if (
      !record(candidate) ||
      candidate.version !== 1 ||
      !identifier(candidate.nonce) ||
      candidate.readId !== readId ||
      candidate.policyGeneration !== policyGeneration ||
      !integer(candidate.revision) ||
      !sameScope(candidate.scope, expectedScope) ||
      !Array.isArray(candidate.requests)
    )
      throw refusal();
    // Only a validated ticket may be sent to nonce-scoped cleanup.
    ticket = candidate;
    if (ticket.requests.length > 64) throw refusal(capacity);
    const tokens = new Set();
    for (const request of ticket.requests) {
      if (
        !record(request) ||
        !identifier(request.token) ||
        tokens.has(request.token) ||
        !["before", "after"].includes(request.pseudo) ||
        !boxValid(request.localBox)
      )
        throw refusal();
      tokens.add(request.token);
    }
    requests = ticket.requests.length;
    const facts = [];
    for (const request of ticket.requests) {
      const owner = await evaluate(expression("geometryOwner", ticket, request.token), false);
      const objectId = owner?.result?.objectId;
      if (
        owner?.exceptionDetails ||
        owner?.result?.subtype !== "node" ||
        typeof objectId !== "string" ||
        objectId.length === 0
      )
        throw refusal();
      const described = await send("DOM.describeNode", { objectId, depth: 0, pierce: false });
      const pseudos = described?.node?.pseudoElements;
      if (!Array.isArray(pseudos) || pseudos.length > 128) throw refusal();
      const selected = pseudos.filter((node) => node?.pseudoType === request.pseudo);
      if (
        selected.length !== 1 ||
        !integer(selected[0]?.backendNodeId) ||
        selected[0].backendNodeId === 0
      )
        throw refusal();
      let offsetX = 0,
        offsetY = 0,
        frameBorder;
      if (!isMainFrame) {
        const model = await send("DOM.getBoxModel", { objectId });
        const border = model?.model?.border,
          local = request.localBox;
        if (
          !quadValid(border) ||
          !near(border[2] - border[0], local.width) ||
          !near(border[5] - border[1], local.height)
        )
          throw refusal();
        offsetX = border[0] - local.left;
        offsetY = border[1] - local.top;
        frameBorder = [...border];
      }
      const result = await send("DOM.getContentQuads", {
        backendNodeId: selected[0].backendNodeId,
      });
      const source = result?.quads;
      if (!Array.isArray(source) || source.length === 0) throw refusal();
      if (source.length > 128 || quads + source.length > 2048) throw refusal(capacity);
      if (!source.every(quadValid)) throw refusal();
      if (frameBorder) {
        // Parent-frame movement is invisible to the child graph's local layout
        // stamp. Refuse a translation that changed while measuring its quads.
        const after = await send("DOM.getBoxModel", { objectId });
        const border = after?.model?.border;
        if (!quadValid(border) || !border.every((n, i) => near(n, frameBorder[i])))
          throw refusal(stale);
      }
      const localQuads = source.map((quad) => quad.map((v, i) => v - (i % 2 ? offsetY : offsetX)));
      if (!localQuads.every(quadValid)) throw refusal();
      quads += localQuads.length;
      facts.push({ token: request.token, pseudo: request.pseudo, quads: localQuads });
    }
    const result = await evaluate(expression("geometryAccept", ticket, facts));
    if (result?.exceptionDetails) throw refusal();
    const value = result?.result?.value;
    if (record(value) && "reason" in value) throw refusal(value.reason);
    if (!record(value) || value.accepted !== requests) throw refusal();
    accepted = true;
    return { ok: true, requests, quads };
  } catch (error) {
    failedReason = failures.has(error) ? error.reason : unsupported;
    return {
      ok: false,
      reason: failedReason,
      requests,
      quads,
    };
  } finally {
    closed = true;
    // These are fire-and-forget cleanup attempts: a stuck provider must not
    // extend the read deadline. Scope+nonce make graph cleanup incarnation safe.
    if (ticket && !accepted)
      release("Runtime.evaluate", {
        contextId,
        expression: expression("geometryAbort", ticket, failedReason),
        returnByValue: true,
        awaitPromise: false,
      });
    for (const objectId of owned) release("Runtime.releaseObject", { objectId });
    release("Runtime.releaseObjectGroup", { objectGroup });
  }
}
