import { describe, expect, it } from "vitest";
import { SyntheticInputGeneratorRegistry } from "../src/adaptive-sessions/synthetic-input-generator.registry.js";
import { vitractSyntheticInputGenerators } from "../src/adaptive-sessions/vitract-synthetic-input.provider.js";

describe("provider-composed synthetic generators", () => {
  const declaration = { generatorContract: "nested_client_order_json", generatorVersion: 1 };
  it("has no implicit provider payload generator in the generic registry", () => {
    expect(() => new SyntheticInputGeneratorRegistry().generate(declaration)).toThrow(
      "SYNTHETIC_GENERATOR_UNAVAILABLE",
    );
  });
  it("uses explicit application composition and fresh safe fixture identities", () => {
    const registry = new SyntheticInputGeneratorRegistry(vitractSyntheticInputGenerators);
    const one = JSON.parse(registry.generate(declaration)),
      two = JSON.parse(registry.generate(declaration));
    expect(one).toMatchObject({
      kitType: "gut-scan",
      client: { email: expect.stringMatching(/@example\.test$/) },
    });
    expect(one.client.email).not.toBe(two.client.email);
  });
  it("refuses conflicting providers and unavailable versions", () => {
    expect(
      () =>
        new SyntheticInputGeneratorRegistry([
          ...vitractSyntheticInputGenerators,
          ...vitractSyntheticInputGenerators,
        ]),
    ).toThrow("SYNTHETIC_GENERATOR_CONFLICT");
    expect(() =>
      new SyntheticInputGeneratorRegistry(vitractSyntheticInputGenerators).generate({
        ...declaration,
        generatorVersion: 2,
      }),
    ).toThrow("SYNTHETIC_GENERATOR_UNAVAILABLE");
  });
});
