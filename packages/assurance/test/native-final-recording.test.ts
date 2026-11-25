import { describe, it } from "vitest";
import { actualNativeFinalRecording } from "./fixtures/actual-native-final-recording.js";
const nativeTest =
  process.env.SCRY_NATIVE_RECORDING_E2E === "1" || process.env.SCRY_BROWSER_E2E === "1"
    ? it
    : it.skip;
describe("actual native worker final recording admission", () => {
  nativeTest.each([
    "normal",
    "delayed-public",
    "stuck-public",
    "delayed-known",
    "generated",
    "api-only",
  ] as const)(
    "keeps physical stop, final read and Chronicle admission ordered (%s)",
    async (mode) => {
      await actualNativeFinalRecording(mode);
    },
    60000,
  );
});
