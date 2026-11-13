/* One retirement authority per recorder instance. Numeric resource IDs never authorize signals. */
export function createOwnedRetirement({
  stopOwnedChild,
  childEnded,
  resourcesAbsent,
  startupConfirmed = () => true,
  acquisitionsConfirmed = () => true,
  waitUntil,
}) {
  const unconfirmed = (code) =>
    Object.assign(Error(code), { code, physicalRetirement: "unconfirmed", mayOwnResources: true });
  let retirement;
  return () =>
    (retirement ??= (async () => {
      try {
        await stopOwnedChild();
        if (!childEnded()) throw unconfirmed("RECORDER_RETIREMENT_UNCONFIRMED");
        if (!(await waitUntil(resourcesAbsent, 2000)))
          throw unconfirmed("RECORDER_RESOURCES_UNCONFIRMED");
        if (!acquisitionsConfirmed())
          throw unconfirmed("RECORDER_RESOURCE_ACQUISITION_UNCONFIRMED");
        if (!startupConfirmed()) throw unconfirmed("RECORDER_STARTUP_RETIREMENT_UNCONFIRMED");
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          error.physicalRetirement === "unconfirmed"
        )
          throw error;
        const failure = unconfirmed("RECORDER_RETIREMENT_UNCONFIRMED");
        failure.cause = error;
        throw failure;
      }
    })());
}

/** An acknowledged slot precedes spawn. Null/missing identity never closes it. */
export function createAcquisitionEvidence({ maxPending = 16, maxHistory = 32 } = {}) {
  const states = new Map();
  let last = 0,
    failed = false;
  const fail = () => {
    failed = true;
    throw Object.assign(Error("RECORDER_RESOURCE_ACQUISITION_UNCONFIRMED"), {
      code: "RECORDER_RESOURCE_ACQUISITION_UNCONFIRMED",
      physicalRetirement: "unconfirmed",
      mayOwnResources: true,
    });
  };
  const known = (id) => {
    if (!Number.isSafeInteger(id) || !states.has(id)) fail();
  };
  return {
    intent(id) {
      if (
        failed ||
        id !== last + 1 ||
        states.size >= maxHistory ||
        [...states.values()].filter((state) => state === "pending").length >= maxPending
      )
        fail();
      states.set(id, "pending");
      last = id;
    },
    registered(id, identity) {
      known(id);
      if (!identity) return;
      if (
        !Number.isSafeInteger(identity.pid) ||
        identity.pid <= 0 ||
        typeof identity.startTicks !== "string" ||
        !/^\d{1,32}$/.test(identity.startTicks)
      )
        fail();
      if (states.get(id) !== "closed") states.set(id, "registered");
    },
    closed(id) {
      known(id);
      states.set(id, "closed");
    },
    confirmed: () => !failed && ![...states.values()].includes("pending"),
  };
}

const startupUnconfirmed = () =>
  Object.assign(Error("RECORDER_STARTUP_HELPER_CAPACITY"), {
    code: "RECORDER_STARTUP_HELPER_CAPACITY",
    physicalRetirement: "unconfirmed",
    mayOwnResources: true,
  });

export function createStartupEvidence() {
  let confirmed = false;
  return {
    accept(kind) {
      if (kind === "startup_drained" || kind === "resources_closed") confirmed = true;
    },
    confirmed: () => confirmed,
  };
}

export function createStartupHelperBudget({ maxCount = 128, maxBytes = 32768 } = {}) {
  const history = new Set();
  let bytes = 0,
    failure;
  const fail = () => {
    throw (failure ??= startupUnconfirmed());
  };
  return {
    children(text) {
      if (failure) throw failure;
      if (Buffer.byteLength(text) > maxBytes) fail();
      const result = text.trim().split(/\s+/).filter(Boolean);
      if (result.length > maxCount || result.some((pid) => !/^\d{1,16}$/.test(pid))) fail();
      return result.map(Number);
    },
    register(token) {
      if (failure) throw failure;
      if (
        !Number.isSafeInteger(token?.pid) ||
        token.pid <= 0 ||
        typeof token.startTicks !== "string" ||
        !/^\d{1,32}$/.test(token.startTicks)
      )
        fail();
      const key = token.pid + ":" + token.startTicks;
      if (history.has(key)) return false;
      const size = Buffer.byteLength(JSON.stringify(token));
      if (history.size >= maxCount || bytes + size > maxBytes) fail();
      history.add(key);
      bytes += size;
      return true;
    },
  };
}
