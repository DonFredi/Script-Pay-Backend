import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { SKIP_RESPONSE_TRANSFORM_KEY } from "../decorators/skip-response-transform.decorator";

export interface ApiSuccessEnvelope<T> {
  success: true;
  message: string;
  statusCode: number;
  payload: T;
}

/**
 * The frontend's shared/lib/api-client.ts and every modules *api.ts file
 * unwraps responses as `{ success, message, statusCode, payload }` and throws
 * ApiCustomError when success is false. Rather than touch every one of those
 * call sites, the backend wraps its responses to match — see
 * HttpExceptionFilter for the matching error-shape half of this contract.
 *
 * Routes marked @SkipResponseTransform() (e.g. the Daraja webhook) are passed
 * through unwrapped, since their response shape is dictated by an external contract.
 */
@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<T, ApiSuccessEnvelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessEnvelope<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_TRANSFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const response = context.switchToHttp().getResponse();
    return next.handle().pipe(
      map((payload) => ({
        success: true as const,
        message: "OK",
        statusCode: response.statusCode,
        payload,
      })),
    );
  }
}
