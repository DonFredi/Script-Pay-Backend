import { of } from "rxjs";
import { ResponseTransformInterceptor } from "./response-transform.interceptor";

function fakeContext(statusCode: number, skip: boolean) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(skip) };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
  } as any;
  return { context, reflector };
}

describe("ResponseTransformInterceptor", () => {
  it("wraps a successful payload in the {success, message, statusCode, payload} envelope", (done) => {
    const { context, reflector } = fakeContext(200, false);
    const interceptor = new ResponseTransformInterceptor(reflector as any);
    const next = { handle: () => of({ id: "tx-1" }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toEqual({ success: true, message: "OK", statusCode: 200, payload: { id: "tx-1" } });
      done();
    });
  });

  it("reflects the actual response statusCode set by the handler, not a hardcoded 200", (done) => {
    const { context, reflector } = fakeContext(201, false);
    const interceptor = new ResponseTransformInterceptor(reflector as any);
    const next = { handle: () => of({ id: "tx-1" }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect((result as any).statusCode).toBe(201);
      done();
    });
  });

  it("passes the payload through UNWRAPPED when @SkipResponseTransform is set (the Daraja webhook contract)", (done) => {
    const { context, reflector } = fakeContext(200, true);
    const interceptor = new ResponseTransformInterceptor(reflector as any);
    const rawDarajaResponse = { ResultCode: 0, ResultDesc: "Accepted" };
    const next = { handle: () => of(rawDarajaResponse) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toBe(rawDarajaResponse);
      done();
    });
  });
});
