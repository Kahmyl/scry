import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Optional } from "@nestjs/common";

export type SyntheticInputGenerator = Readonly<{
  contract: string;
  version: number;
  generate(): string;
}>;
export const APPLICATION_SYNTHETIC_INPUT_GENERATORS = Symbol(
  "APPLICATION_SYNTHETIC_INPUT_GENERATORS",
);
const core: readonly SyntheticInputGenerator[] = [
  {
    contract: "reserved_test_email",
    version: 1,
    generate: () => `scry-${randomUUID()}@example.test`,
  },
  {
    contract: "synthetic_person_name",
    version: 1,
    generate: () => `ScryTest${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  },
  { contract: "opaque_operation_token", version: 1, generate: () => randomUUID() },
  {
    contract: "sandbox_shipping_address_json",
    version: 1,
    generate: () =>
      JSON.stringify({
        country: "US",
        addressLineOne: `${randomUUID().slice(0, 6)} Test Way`,
        city: "Test City",
        state: "CA",
        postalCode: "90210",
      }),
  },
];

@Injectable()
export class SyntheticInputGeneratorRegistry {
  private readonly generators = new Map<string, SyntheticInputGenerator>();
  constructor(
    @Optional()
    @Inject(APPLICATION_SYNTHETIC_INPUT_GENERATORS)
    application: readonly SyntheticInputGenerator[] = [],
  ) {
    for (const generator of [...core, ...application]) {
      const key = `${generator.contract}:${generator.version}`;
      if (this.generators.has(key)) throw new ConflictException("SYNTHETIC_GENERATOR_CONFLICT");
      this.generators.set(key, generator);
    }
  }
  generate(declaration: { generatorContract: string; generatorVersion: number }) {
    const generator = this.generators.get(
      `${declaration.generatorContract}:${declaration.generatorVersion}`,
    );
    if (!generator) throw new ConflictException("SYNTHETIC_GENERATOR_UNAVAILABLE");
    return generator.generate();
  }
}
