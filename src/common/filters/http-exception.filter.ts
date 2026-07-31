import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { Response } from "express";

/**
 * Every error response matches the frontend's ApiError shape exactly
 * (shared/types/index.ts): { success: false, message, statusCode, error? }.
 * Unhandled (non-HttpException) errors are logged in full server-side AND reported
 * to Sentry, but never expose their message/stack to the client — a stack trace in
 * an API response is an information-disclosure risk on a platform handling
 * financial data and tenant credentials.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === "string" ? body : ((body as any)?.message ?? exception.message);

      // Only report 5xx to Sentry — 4xx (validation errors, auth failures) are
      // expected traffic noise, not incidents worth paging anyone over.
      if (status >= 500) {
        Sentry.captureException(exception);
      }

      response.status(status).json({
        success: false,
        message: Array.isArray(message) ? message.join(", ") : message,
        statusCode: status,
        ...(typeof body === "object" && (body as any)?.issues ? { error: { details: (body as any).issues } } : {}),
      });
      return;
    }

    this.logger.error("Unhandled exception", exception as Error);
    Sentry.captureException(exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: "Internal server error",
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  }
}
