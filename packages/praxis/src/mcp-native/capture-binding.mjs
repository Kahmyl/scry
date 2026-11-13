/** Private-world binding. Its callback registers finite producer work synchronously. */
export async function installCaptureBinding(session, protection, onGap) {
  const receive = (event) => {
    if (event.name !== "__scryNativeGap") return;
    protection.acceptGap(event.payload);
    for (const reason of protection.drainGaps()) onGap(reason);
  };
  session.on("Runtime.bindingCalled", receive);
  await session.send("Runtime.enable");
  await session.send("Runtime.addBinding", {
    name: "__scryNativeGap",
    executionContextName: "scry-native-protection",
  });
  return () => session.off("Runtime.bindingCalled", receive);
}
