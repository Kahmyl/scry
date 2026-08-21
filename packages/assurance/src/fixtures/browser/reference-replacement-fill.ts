import type { AssuranceEvidenceRef } from "../../core/types.js";

import type { VerificationObservation } from "../../core/results.js";

import { defineFixture, type FixtureSession } from "../primitives.js";

import { startBrowserFixtureServer, type BrowserFixtureServer } from "./server.js";

export interface ReferenceReplacementFillTruth {
  mutationCount: number;

  originalDispatches: number;

  replacementDispatches: number;
}

export interface ReferenceReplacementFillFixtureValue {
  scenarioUrl: string;
}

const servers = new WeakMap<object, BrowserFixtureServer>();

export const referenceReplacementFillFixture = defineFixture<
  ReferenceReplacementFillFixtureValue,
  ReferenceReplacementFillTruth
>({
  id: "reference-replacement-fill",
  title: "Reference replacement fill fixture",

  description:
    "Replaces a fill target after observation and records fill dispatches independently on the fixture server.",

  async setup() {
    const truth: ReferenceReplacementFillTruth = {
      mutationCount: 0,
      originalDispatches: 0,
      replacementDispatches: 0,
    };

    let origin = "";

    const server = await startBrowserFixtureServer([
      async ({ request, response, url, readJson }) => {
        if (request.method === "GET" && url.pathname === "/scenario/reference-replacement-fill") {
          response.statusCode = 200;

          response.setHeader("content-type", "text/html; charset=utf-8");

          response.end(fixtureDocument());

          return true;
        }

        if (
          request.method === "POST" &&
          url.pathname === "/__assurance/reference-replacement-fill/event"
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
          url.pathname === "/__assurance/reference-replacement-fill/truth"
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

    const session: FixtureSession<
      ReferenceReplacementFillFixtureValue,
      ReferenceReplacementFillTruth
    > = {
      value: {
        scenarioUrl: server.url("/scenario/reference-replacement-fill"),
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

export function verifyFillReferenceDidNotDispatch(
  truth: ReferenceReplacementFillTruth,
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
      summary: "A fill dispatch occurred after the observed target was replaced.",
    };
  }

  return {
    status: "pass",
    evidence,
    summary:
      "The target was replaced and no fill dispatch reached either the original or replacement input.",
  };
}

function evidenceFor(truth: ReferenceReplacementFillTruth): readonly AssuranceEvidenceRef[] {
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
  <title>Reference replacement fill fixture</title>
</head>
<body>
  <label>
    Email
    <input id="target" placeholder="Email">
  </label>
  <output id="state">original</output>

  <script>
    const eventUrl =
      "/__assurance/reference-replacement-fill/event";

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

    const currentState = () =>
      document.querySelector("#state");

    const post = async (target) => {
      await send({
        type: "dispatch",
        target
      });
    };

    original.addEventListener(
      "input",
      async () => {
        await post("original");
      },
    );

    window.__replaceInputTarget = () => {
      const replacement =
        document.createElement("input");

      replacement.id =
        "replacement";

      replacement.placeholder =
        "Email";

      replacement.setAttribute("name", "Email");

      replacement.addEventListener(
        "input",
        async () => {
          await post("replacement");
        },
      );

      original.replaceWith(replacement);

      const state =
        currentState();

      if (state) {
        state.textContent =
          "replaced";
      }

      void send({
        type: "mutated"
      });
    };
  </script>
</body>
</html>`;
}
