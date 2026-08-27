import { type ArgumentsHost, BadRequestException, HttpStatus, UnauthorizedException } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { HttpExceptionFilter } from "./http-exception.filter";

jest.mock("@sentry/node", () => ({ captureException: jest.fn() }));

function fakeHost(response: { status: jest.Mock; json: jest.Mock }): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
}

function fakeResponse() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    jest.clearAllMocks();
    filter = new HttpExceptionFilter();
  });

  it("shapes a simple HttpException into the frontend's ApiError contract", () => {
    const res = fakeResponse();
    filter.catch(new UnauthorizedException("Invalid credentials"), fakeHost(res));

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "Invalid credentials",
      statusCode: 401,
    });
  });

  it("joins an array-shaped message (Nest's default validation error shape) into one string", () => {
    const res = fakeResponse();
    filter.catch(new BadRequestException(["email must be an email", "password is too short"]), fakeHost(res));

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "email must be an email, password is too short" }),
    );
  });

  it("surfaces ZodValidationPipe's `issues` array as error.details without leaking anything else", () => {
    const res = fakeResponse();
    const zodStyle = new BadRequestException({ message: "Validation failed", issues: [{ path: "email" }] });
    filter.catch(zodStyle, fakeHost(res));

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: { details: [{ path: "email" }] } }),
    );
  });

  it("does not report a 4xx HttpException to Sentry — expected traffic, not an incident", () => {
    const res = fakeResponse();
    filter.catch(new BadRequestException("bad input"), fakeHost(res));

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("reports a 5xx HttpException to Sentry", () => {
    const res = fakeResponse();
    const serverError = new (class extends BadRequestException {})("boom");
    jest.spyOn(serverError, "getStatus").mockReturnValue(500);
    filter.catch(serverError, fakeHost(res));

    expect(Sentry.captureException).toHaveBeenCalledWith(serverError);
  });

  it("never leaks a raw (non-HttpException) error's message or stack to the client", () => {
    const res = fakeResponse();
    const internalError = new Error("connection string contains password=hunter2");
    filter.catch(internalError, fakeHost(res));

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "Internal server error",
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("hunter2");
  });

  it("still reports an unhandled (non-HttpException) error to Sentry", () => {
    const res = fakeResponse();
    const internalError = new Error("unexpected");
    filter.catch(internalError, fakeHost(res));

    expect(Sentry.captureException).toHaveBeenCalledWith(internalError);
  });
});
