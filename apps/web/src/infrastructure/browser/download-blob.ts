/**
 * Browser-native operator UI download.
 *
 * This is presentation-layer DOM behavior in Scry's own dashboard. It does
 * not control a Praxis target browser, choose a semantic target, or perform
 * agent-directed execution.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);

  try {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(href);
  }
}
