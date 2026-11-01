import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { publicBrowserErrorCode } from "@scry/veil";

type HttpReply = { status(code: number): HttpReply; send(body: unknown): void };

@Catch()
export class BrowserExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<HttpReply>();
    if (exception instanceof HttpException) {
      reply.status(exception.getStatus()).send(exception.getResponse());
      return;
    }
    const code = publicBrowserErrorCode(exception);
    if (!code) {
      reply
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ statusCode: 500, message: "Internal server error" });
      return;
    }
    const status = browserErrorStatus(code);
    reply.status(status).send({ code, status, safeActions: browserSafeActions(code) });
  }
}

export function browserErrorStatus(code: string): number {
  if (
    code === "SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED" ||
    code === "SCRY_BROWSER_CAPACITY_CONFIGURATION_INVALID"
  )
    return HttpStatus.SERVICE_UNAVAILABLE;
  if (code.includes("DISABLED") || code.includes("RUNTIME_UNAVAILABLE"))
    return HttpStatus.SERVICE_UNAVAILABLE;
  if (code.includes("FORBIDDEN")) return HttpStatus.FORBIDDEN;
  if (code.includes("UNAUTHORIZED")) return HttpStatus.UNAUTHORIZED;
  if (code.includes("NOT_FOUND")) return HttpStatus.NOT_FOUND;
  if (code.includes("INVALID") || code.includes("DUPLICATE")) return HttpStatus.BAD_REQUEST;
  return HttpStatus.CONFLICT;
}

function browserSafeActions(code: string): string[] {
  if (code === "SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED")
    return [
      "Browser capacity is currently in use. This start request launched no browser and performed no application action.",
      "Wait for capacity, or finish a Run you own through normal finalization; then retry the same start request. Do not repeat any prior business action.",
    ];
  if (code === "SCRY_BROWSER_CAPACITY_CONFIGURATION_INVALID")
    return ["Browser capacity configuration is unavailable. Contact the deployment operator."];
  if (code.includes("NOT_FOUND") || code.includes("CONTEXT_INVALID"))
    return ["verify_workspace_scope_and_identifiers"];
  if (code.includes("BUDGET_EXHAUSTED")) return ["stop_without_dispatch", "report_budget_refusal"];
  if (code.includes("STALE") || code.includes("FENCED")) return ["refresh_current_session_state"];
  return [];
}
