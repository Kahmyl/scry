import { describe, expect, it } from "vitest";

import { operationOutcomeSchema } from "../src/execution-kernel.js";

describe("read-only browser sensor contract", () => {
  it("admits only bounded factual browser metadata", () => {
    const outcome = operationOutcomeSchema.parse({
      operationId: "observe-current-document",
      functionalResult: "succeeded",
      mutationOutcome: "not_applied",
      privacyResult: "verified",
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 1,
      semanticPageContext: {
        schemaVersion: 2,
        authority: {
          pageId: "page-authority",
          documentEpoch: 2,
          url: "https://example.test/",
          title: "Example",
          readiness: "stable",
        },
        completeness: {
          kind: "bounded",
          observed: 0,
          returned: 0,
          truncated: false,
        },
        controls: [],
        browserSensor: {
          kind: "chromium_read_only",
          authority: {
            frameId: "frame-1",
            loaderId: "loader-2",
            previousLoaderId: "loader-1",
            loaderChanged: true,
            loaderTransitionsObserved: 1,
          },
          network: {
            observedRequests: 2,
            recentRequests: [
              {
                requestId: "request-2",
                loaderId: "loader-2",
                frameId: "frame-1",
                type: "Document",
                monotonicTimestamp: 42,
              },
            ],
            observedFailures: 1,
            recentFailures: [
              {
                requestId: "request-1",
                type: "Image",
                monotonicTimestamp: 40,
                reasonCode: "NET::ERR_EMPTY_RESPONSE",
                canceled: false,
              },
            ],
            truncated: true,
          },
          layout: {
            clientWidth: 900,
            clientHeight: 600,
          },
        },
      },
    });

    expect(outcome.semanticPageContext?.browserSensor).toMatchObject({
      kind: "chromium_read_only",
      authority: {
        loaderChanged: true,
        loaderTransitionsObserved: 1,
      },
      network: {
        observedRequests: 2,
        observedFailures: 1,
        truncated: true,
      },
    });
  });

  it("rejects arbitrary network failure text", () => {
    expect(() =>
      operationOutcomeSchema.parse({
        operationId: "observe-current-document",
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
        semanticPageContext: {
          schemaVersion: 2,
          authority: {
            pageId: "page-authority",
            documentEpoch: 1,
            url: "https://example.test/",
            title: "Example",
            readiness: "stable",
          },
          completeness: {
            kind: "bounded",
            observed: 0,
            returned: 0,
            truncated: false,
          },
          controls: [],
          browserSensor: {
            kind: "chromium_read_only",
            authority: {
              frameId: "frame-1",
              loaderId: "loader-1",
              loaderChanged: false,
              loaderTransitionsObserved: 0,
            },
            network: {
              observedRequests: 0,
              recentRequests: [],
              observedFailures: 1,
              recentFailures: [
                {
                  requestId: "request-1",
                  monotonicTimestamp: 1,
                  reasonCode: "request failed with private user data",
                  canceled: false,
                },
              ],
              truncated: false,
            },
            layout: {
              clientWidth: 900,
              clientHeight: 600,
            },
          },
        },
      }),
    ).toThrow();
  });
});
