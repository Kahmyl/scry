import { randomUUID } from "node:crypto";
import type { SyntheticInputGenerator } from "./synthetic-input-generator.registry.js";

/** Application composition owns the provider's test-order payload shape. */
export const vitractSyntheticInputGenerators: readonly SyntheticInputGenerator[] = [
  {
    contract: "nested_client_order_json",
    version: 1,
    generate() {
      const nonce = randomUUID().replaceAll("-", "");
      return JSON.stringify({
        orderType: "monthly-billing",
        orderedFor: "client",
        quantity: 1,
        kitType: "gut-scan",
        currency: "usd",
        deliveryMode: "dropship",
        client: {
          firstName: `ScryTest${nonce.slice(0, 8)}`,
          lastName: `Client${nonce.slice(8, 16)}`,
          email: `scry-${nonce}@example.test`,
        },
        shipping: {
          country: "US",
          addressLineOne: `${nonce.slice(0, 6)} Test Way`,
          city: "Test City",
          state: "CA",
          postalCode: "90210",
        },
      });
    },
  },
];
