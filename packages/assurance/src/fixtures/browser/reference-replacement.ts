import type { AssuranceEvidenceRef } from "../../core/types.js";

import type { VerificationObservation } from "../../core/results.js";

import { defineFixture, type FixtureSession } from "../primitives.js";

import { startBrowserFixtureServer, type BrowserFixtureServer } from "./server.js";

export interface ReferenceReplacementTruth {
  mutationCount: number;

  originalDispatches: number;

  replacementDispatches: number;
}

export interface ReferenceReplacementFixtureValue {
  origin: string;

  scenarioUrl: string;

  eventUrl: string;
}

const servers = new WeakMap<object, BrowserFixtureServer>();

export const referenceReplacementFixture = defineFixture<
  ReferenceReplacementFixtureValue,
  ReferenceReplacementTruth
>({
  id: "reference-replacement",
  title: "Reference replacement fixture",

  description:
    "Replaces a browser target after observation and records all dispatches independently on the fixture server.",

  async setup() {
    const truth: ReferenceReplacementTruth = {
      mutationCount: 0,
      originalDispatches: 0,
      replacementDispatches: 0,
    };

    let origin = "";

    const server = await startBrowserFixtureServer([
      async ({ request, response, url, readJson }) => {
        if (request.method === "GET" && url.pathname === "/scenario/reference-replacement") {
          response.statusCode = 200;

          response.setHeader("content-type", "text/html; charset=utf-8");

          response.end(fixtureDocument());

          return true;
        }

        if (
          request.method === "POST" &&
          url.pathname === "/__assurance/reference-replacement/event"
        ) {
          const event = await readJson<
            | {
                type: "mutated";
              }
            | {
                type: "dispatch";
                target: "original" | "replacement";
              }
          >();

          if (event.type === "mutated") {
            truth.mutationCount += 1;
          } else if (event.target === "original") {
            truth.originalDispatches += 1;
          } else {
            truth.replacementDispatches += 1;
          }

          response.statusCode = 204;
          response.end();

          return true;
        }

        if (
          request.method === "GET" &&
          url.pathname === "/__assurance/reference-replacement/truth"
        ) {
          response.statusCode = 200;

          response.setHeader("content-type", "application/json; charset=utf-8");

          response.end(JSON.stringify(truth));

          return true;
        }

        return false;
      },
    ]);

    origin = server.origin;

    const session: FixtureSession<ReferenceReplacementFixtureValue, ReferenceReplacementTruth> = {
      value: {
        origin,

        scenarioUrl: server.url("/scenario/reference-replacement"),

        eventUrl: server.url("/__assurance/reference-replacement/event"),
      },

      readGroundTruth() {
        return {
          ...truth,
        };
      },
    };

    servers.set(session, server);

    return session;
  },

  async teardown(session) {
    const server = servers.get(session);

    servers.delete(session);

    await server?.close();
  },
});

export function verifyStaleReferenceDidNotDispatch(
  truth: ReferenceReplacementTruth,
): VerificationObservation {
  const evidence = evidenceFor(truth);

  if (truth.mutationCount < 1) {
    return {
      status: "inconclusive",
      evidence,
      reasonCode: "REFERENCE_REPLACEMENT_NOT_OBSERVED",
      summary:
        "The fixture never observed the target replacement, so stale-reference behavior was not exercised.",
    };
  }

  if (truth.originalDispatches > 0 || truth.replacementDispatches > 0) {
    return {
      status: "fail",
      evidence,
      reasonCode: "STALE_REFERENCE_DISPATCH_OBSERVED",
      summary: "A dispatch occurred after the observed target was replaced.",
    };
  }

  return {
    status: "pass",
    evidence,
    summary:
      "The target was replaced and no dispatch occurred against either the original or replacement entity.",
  };
}

function evidenceFor(truth: ReferenceReplacementTruth): readonly AssuranceEvidenceRef[] {
  return [
    {
      source: "fixture",
      kind: "reference-replacement-ground-truth",

      ref:
        `mutation:${truth.mutationCount}` +
        `;original:${truth.originalDispatches}` +
        `;replacement:${truth.replacementDispatches}`,

      description: JSON.stringify(truth),
    },
  ];
}

function fixtureDocument(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Reference replacement fixture</title>
</head>
<body>
  <button id="target">Submit order</button>
  <output id="state">original</output>

  <script>
    const eventUrl =
      "/__assurance/reference-replacement/event";

    const send = async (event) => {
      await fetch(eventUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(event)
      });
    };

    const original =
      document.querySelector("#target");

    const state =
      document.querySelector("#state");

    original.addEventListener(
      "click",
      () => {
        void send({
          type: "dispatch",
          target: "original"
        });
      }
    );

    original.addEventListener(
      "pointerover",
      () => {
        const replacement =
          document.createElement("button");

        replacement.id =
          "replacement";

        replacement.textContent =
          "Submit order";

        replacement.addEventListener(
          "click",
          () => {
            void send({
              type: "dispatch",
              target: "replacement"
            });
          }
        );

        original.replaceWith(
          replacement,
        );

        state.textContent =
          "replaced";

        void send({
          type: "mutated"
        });
      },
      {
        once: true
      }
    );
  </script>
</body>
</html>`;
}
