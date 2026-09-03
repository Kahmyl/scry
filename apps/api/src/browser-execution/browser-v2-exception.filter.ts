import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";

type HttpReply = { status(code: number): HttpReply; send(body: unknown): void };

@Catch()
export class BrowserV2ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<HttpReply>();
    if (exception instanceof HttpException) {
      reply.status(exception.getStatus()).send(exception.getResponse());
      return;
    }
    const code = safeBrowserV2Code(exception);
    if (!code) {
      reply
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ statusCode: 500, message: "Internal server error" });
      return;
    }
    const status = browserV2ErrorStatus(code);
    reply.status(status).send({ code, status, safeActions: browserV2SafeActions(code) });
  }
}

export function browserV2ErrorStatus(code: string): number {
  if (code.includes("DISABLED") || code.includes("RUNTIME_UNAVAILABLE"))
    return HttpStatus.SERVICE_UNAVAILABLE;
  if (code.includes("FORBIDDEN")) return HttpStatus.FORBIDDEN;
  if (code.includes("UNAUTHORIZED")) return HttpStatus.UNAUTHORIZED;
  if (code.includes("NOT_FOUND")) return HttpStatus.NOT_FOUND;
  if (code.includes("INVALID") || code.includes("DUPLICATE")) return HttpStatus.BAD_REQUEST;
  return HttpStatus.CONFLICT;
}

function safeBrowserV2Code(exception: unknown): string | undefined {
  const raw = exception instanceof Error ? exception.message : String(exception);
  return /^BROWSER_V2_[A-Z0-9_]+$/u.test(raw) ? raw : undefined;
}

function browserV2SafeActions(code: string): string[] {
  if (code.includes("NOT_FOUND") || code.includes("CONTEXT_INVALID"))
    return ["verify_workspace_scope_and_identifiers"];
  if (code.includes("BUDGET_EXHAUSTED")) return ["stop_without_dispatch", "report_budget_refusal"];
  if (code.includes("STALE") || code.includes("FENCED")) return ["refresh_current_session_state"];
  return [];
}
