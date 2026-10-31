export async function runNativeBrowserAdapterWorker(
  factory: (secrets: Record<string, string>) => { clean(value: unknown): unknown; script: string },
): Promise<void> {
  // @ts-expect-error Private JavaScript driver module, characterized by native integration tests.
  const { startBrowserAdapter } = await import("./mcp-native/browser-worker.mjs");
  startBrowserAdapter(factory);
}
