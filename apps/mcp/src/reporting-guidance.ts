import type { publishBrowserMissionReportSchema } from "@scry/contracts";
import type { z } from "zod";

/** Format example only; no fictional completed check or invented evidence ID. */
export const reportPayloadExample = {
  summary: "Account recovery was not tested.",
  safeReport: {
    presentation: {
      subject: "application",
      scope: ["Account recovery"],
      checks: [
        {
          title: "Account recovery",
          actual: "Not exercised in this test",
          status: "not_tested",
          evidence: [],
        },
      ],
      observations: [],
      limitations: ["Account recovery remains unverified"],
    },
  },
} satisfies Pick<z.input<typeof publishBrowserMissionReportSchema>, "summary" | "safeReport">;

/** One reporting direction for initialize and tools/list, in both MCP profiles. */
export const reportingInstructions = [
  "Customer reports describe the tested application, not Scry's tools, capabilities or qualification results. Work from the user's requested journeys; report what was actually checked, observed and left unverified. Do not invent an expectation: use the user's requirements or established intended application behavior; otherwise describe an observation or an inconclusive check.",
  "If one interaction method fails, inspect the last actual application state before choosing another authorized method. No automatic retry or blind repetition of an uncertain write. A verified recovered outcome can complete the application check; the first method's failure is not itself an application defect. Tool completion, matching input text and a complete recording are not proof of saved or visually correct application state.",
  "Publish with safeReport.presentation: subject='application', scope, checks, observations and limitations. Each check has title, actual, status and optional expected/evidence. Use matched_expectation or different_from_expectation only with an explicit application expectation; use inconclusive for an uncertain result and not_tested for a check not exercised. Include relevant app observations after recovery. Suggestions are advisory, not automatic defect judgments.",
  "Keep tool errors, Scry failures, traces and custody/runtime details in operator diagnostics, not customer narrative. Do not request operator credentials. State any resulting test or evidence gap honestly without diagnosing the app from a platform problem. Internal finalize_run outcomes are lifecycle facts, not customer app verdicts.",
  "Use only actual runId/artifactId references returned for this Mission. Never invent or substitute evidence. The API derives recording coverage; report requested-check coverage separately, without claiming every scenario was tested. Finish terminal work before publishing. Prefer the application presentation; historical-format acceptance is compatibility only and does not produce structured customer checks.",
  "For an existing result, use list_reports to locate the saved report and get_report to read its recorded application checks and limitations; do not reconstruct it from conversation memory or start another test. get_mission may return its finalReportId and navigation links. Share only returned reportUrl/evidenceUrl values. These are authenticated dashboard navigation links, not public or signed media URLs. Evidence references and coverage metadata do not mean you watched the recording or inspected the screenshot. Preserve missing, incomplete and unavailable evidence honestly.",
  "Example report payload (format only; replace with actual findings, add the observed missionId and agentSessionId, and never copy an unperformed test as completed): " +
    JSON.stringify(reportPayloadExample),
].join("\n\n");
