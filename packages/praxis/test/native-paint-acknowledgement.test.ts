import { describe, it } from "vitest";
import {
  nativePaintAcknowledgement,
  paintAcknowledgementCases,
} from "./fixtures/native-paint-acknowledgement.js";

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;
describe("native completed paint acknowledgement", () => {
  browserTest.each(paintAcknowledgementCases)(
    "checks isolated scheduler failure: %s",
    async (mode) => {
      await nativePaintAcknowledgement(mode);
    },
  );
});
