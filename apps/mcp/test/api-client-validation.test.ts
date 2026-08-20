import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  apiRejection,
  ScryApiClient,
  ScryApiError,
} from "../src/api-client.js";

describe("ScryApiClient validation rejection projection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies ordinary validation message arrays without exposing raw validation text", async () => {
    const rawValidationMessage =
      'Unrecognized key: "externalResourcePresentationAuthorities"';

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 400,
            message: [rawValidationMessage],
            error: "Bad Request",
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    );

    const client =
      new ScryApiClient("http://scry.test/api");

    let caught: unknown;

    try {
      await client.patch(
        "/environments/example",
        { intentionallyInvalid: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ScryApiError);

    const rejection =
      apiRejection(caught as ScryApiError);

    expect(rejection).toEqual({
      code: "SCRY_API_REQUEST_VALIDATION_FAILED",
      status: 400,
      appliedState: "not_applied",
      retry: "unspecified",
      safeActions: [],
      context: {
        validationIssueCount: 1,
      },
    });

    expect(JSON.stringify(rejection))
      .not.toContain(rawValidationMessage);

    expect(JSON.stringify(rejection))
      .not.toContain(
        "externalResourcePresentationAuthorities",
      );
  });

  it("preserves a structured API code instead of replacing it with validation classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 400,
            message: {
              code: "MISSION_CONTEXT_INVALID",
              safeActions: ["resume_mission"],
              mutationOutcome: "not_applied",
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    );

    const client =
      new ScryApiClient("http://scry.test/api");

    let caught: unknown;

    try {
      await client.patch(
        "/environments/example",
        {},
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ScryApiError);

    expect(
      apiRejection(caught as ScryApiError),
    ).toMatchObject({
      code: "MISSION_CONTEXT_INVALID",
      status: 400,
      appliedState: "not_applied",
      safeActions: ["resume_mission"],
    });
  });
});
