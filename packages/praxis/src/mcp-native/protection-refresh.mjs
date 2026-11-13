// Transports Veil-owned private facts; never classifies field semantics.
const currentReads = new WeakMap();
export async function refreshNativeProtection({
  protection,
  sessions,
  dialogs,
  maskTasks,
  pixelTasks,
  recovered,
  degrade,
  phase,
  pages,
  pageId = () => 0,
  selectedPage,
  finalReadChallenge,
}) {
  // Critical facts and optional paint have independent pending lanes. The
  // combined wait retains the existing 200ms budget; optional animation frames
  // must not consume admission time before descendant facts have been read.
  const started = Date.now();
  const read = protection.beginNativeRead(finalReadChallenge);
  currentReads.set(protection, read);
  const blocked = new Set(dialogs.values());
  const expected = pages.filter((page) => !page.isClosed());
  const active = [...sessions].filter(([page]) => !page.isClosed());
  if (active.length > 8) protection.capacityExceeded();
  for (const page of blocked) degrade(page, "dialog_refresh_deferred");
  let frameCount = 0,
    completedPages = 0;
  const worlds = new Map();
  await maskTasks.run(
    active
      .filter(([page]) => !blocked.has(page))
      .slice(0, 8)
      .map(([page, session], index) => [
        page,
        async () => {
          phase("mask_frame_tree:page" + index);
          const { frameTree } = await session.send("Page.getFrameTree");
          const frames = [];
          const visit = (tree) => {
            if (++frameCount > 16) {
              protection.capacityExceeded();
              throw Error("MASK_FRAME_CAPACITY");
            }
            frames.push(tree.frame.id);
            for (const child of tree.childFrames ?? []) visit(child);
          };
          visit(frameTree);
          const contexts = [];
          for (const [worldId, frameId] of frames.entries()) {
            phase("mask_world");
            const world = await session.send("Page.createIsolatedWorld", {
              frameId,
              worldName: "scry-native-protection",
              grantUniveralAccess: false,
            });
            phase("mask_refresh");
            const refreshed = await session.send("Runtime.evaluate", {
              contextId: world.executionContextId,
              expression: protection.readExpressionFor({ pageId: pageId(page), worldId }),
              awaitPromise: true,
              returnByValue: true,
            });
            // Raw learned facts stay inside this worker and the Veil capability.
            // Never put them in phase/error events, durable results or IPC.
            if (
              refreshed.exceptionDetails ||
              !protection.acceptNativeRead(read, refreshed.result?.value, {
                pageId: pageId(page),
                worldId,
              })
            )
              throw Error("MASK_REFRESH_UNCONFIRMED");
            contexts.push({ contextId: world.executionContextId, worldId });
          }
          worlds.set(page, { session, contexts });
          completedPages++;
        },
      ]),
  );
  protection.finishNativeRead(
    read,
    blocked.size === 0 &&
      expected.every((page) => sessions.has(page)) &&
      active.length <= 8 &&
      completedPages === active.length,
    selectedPage ? pageId(selectedPage) : selectedPage === null ? -1 : undefined,
    expected.filter((page) => !worlds.has(page)).map(pageId),
  );
  const remaining = Math.max(0, 200 - (Date.now() - started));
  const painted = new Set();
  if (remaining > 0)
    await pixelTasks.run(
      [...worlds].map(([page, { session, contexts }]) => [
        page,
        async () => {
          // Every fact is already admitted or withheld before optional paint.
          await Promise.all(
            contexts.map(async ({ contextId, worldId }) => {
              phase("mask_paint");
              const refreshed = await session.send("Runtime.evaluate", {
                contextId,
                expression: protection.pixelExpression,
                awaitPromise: true,
                returnByValue: true,
              });
              if (
                refreshed.exceptionDetails ||
                !protection.acceptNativePaint(read, refreshed.result?.value, {
                  pageId: pageId(page),
                  worldId,
                })
              )
                throw Error("MASK_PIXEL_REFRESH_UNCONFIRMED");
            }),
          );
          if (currentReads.get(protection) === read && protection.observationAvailable()) {
            painted.add(page);
            recovered(page);
          }
        },
      ]),
      remaining,
    );
  // A pending paint from an older read can occupy only the optional lane. It
  // cannot certify a new read or clear the new read's warning on completion.
  protection.finishNativePaint(read);
  for (const [page] of worlds) if (!painted.has(page)) degrade(page, "maintenance_failed");
  return read;
}
