/** Isolated fault injection around the real worker, never a product entrypoint. */
import { createNativeAdapterProtector } from "@scry/veil";
import { runNativeBrowserAdapterWorker } from "@scry/praxis";

await runNativeBrowserAdapterWorker((secrets, options) => {
  const { FIXTURE_MODE: mode, ...protectedValues } = secrets;
  const protection = createNativeAdapterProtector(protectedValues, options);
  const begin = protection.beginNativeRead.bind(protection);
  const expression = protection.readExpressionFor.bind(protection);
  let finalOrdinal = 0;
  let firstChallenge: string | undefined;
  let delayCurrentRead = false;
  protection.beginNativeRead = (challenge) => {
    const read = begin(challenge);
    delayCurrentRead = false;
    if (challenge) {
      firstChallenge ??= challenge;
      ++finalOrdinal;
      delayCurrentRead =
        finalOrdinal === 1 &&
        ["delayed-public", "stuck-public", "delayed-known"].includes(mode ?? "");
      process.send?.({
        type: "fixture_final_read",
        ordinal: finalOrdinal,
        sameChallenge: challenge === firstChallenge,
        read,
      });
    }
    return read;
  };
  protection.readExpressionFor = (source) => {
    const original = expression(source);
    if (!delayCurrentRead) return original;
    return mode === "stuck-public"
      ? "new Promise(() => {})"
      : `(async () => { await new Promise(resolve => setTimeout(resolve, 240)); return (${original}); })()`;
  };
  return protection;
});
