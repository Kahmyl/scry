/** Private worker capability; raw learned values never cross parent IPC. */
import type { NativeBrowserProtectionPort, NativeCaptureEpoch } from "@scry/contracts";
export type NativeAdapterProtection = NativeBrowserProtectionPort;
export async function runNativeBrowserAdapterWorker(
  factory: (
    secrets: Record<string, string>,
    options?: { captureEpoch?: NativeCaptureEpoch },
  ) => NativeAdapterProtection,
): Promise<void> {
  // @ts-expect-error Private JavaScript driver module, characterized by native integration tests.
  const { startBrowserAdapter } = await import("./mcp-native/browser-worker.mjs");
  startBrowserAdapter(factory);
}
