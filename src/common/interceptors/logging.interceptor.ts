import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { randomUUID } from "node:crypto";

/**
 * Structured, not string-concatenated — every log line is one JSON object with
 * consistent fields, so log aggregation/search works from day one instead of being
 * retrofitted later. tenantId is included whenever available: "what happened to
 * transaction X for tenant Y" is the first question support will ask, every time.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const correlationId = request.headers["x-correlation-id"] ?? randomUUID();
    const start = Date.now();

    request.correlationId = correlationId;

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(
            JSON.stringify({
              correlationId,
              method: request.method,
              path: request.url,
              tenantId: request.tenantId ?? request.user?.tenantId ?? null,
              durationMs: Date.now() - start,
              status: "success",
            }),
          );
        },
        error: (err) => {
          this.logger.warn(
            JSON.stringify({
              correlationId,
              method: request.method,
              path: request.url,
              tenantId: request.tenantId ?? request.user?.tenantId ?? null,
              durationMs: Date.now() - start,
              status: "error",
              errorMessage: err?.message,
            }),
          );
        },
      }),
    );
  }
}
