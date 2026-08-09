import { describe, expect, it } from "vitest";

import { missionLiveArguments } from "../scripts/mission-live-arguments.js";

describe("mission live campaign arguments", () => {
  it("accepts pnpm's explicit argument separator", () => {
    expect(missionLiveArguments(["--", "orangehrm", "1"])).toEqual(["orangehrm", "1"]);
  });

  it("preserves direct invocation arguments", () => {
    expect(missionLiveArguments(["xyz_bank", "3"])).toEqual(["xyz_bank", "3"]);
  });
});
