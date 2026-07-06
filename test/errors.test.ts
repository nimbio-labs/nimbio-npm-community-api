import { describe, expect, it } from "vitest";
import {
  exceptionFor,
  APIError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  RateLimitError,
  GateNotOpenedError,
  UpstreamError,
  ServerError,
  NimbioError,
} from "../src/index.js";

describe("exceptionFor mapping", () => {
  it("maps statuses to the right subclass", () => {
    expect(exceptionFor(400)).toBe(BadRequestError);
    expect(exceptionFor(401)).toBe(AuthenticationError);
    expect(exceptionFor(403)).toBe(PermissionDeniedError);
    expect(exceptionFor(404)).toBe(NotFoundError);
    expect(exceptionFor(429)).toBe(RateLimitError);
    expect(exceptionFor(502)).toBe(UpstreamError);
    expect(exceptionFor(503)).toBe(UpstreamError);
    expect(exceptionFor(504)).toBe(GateNotOpenedError);
    expect(exceptionFor(500)).toBe(ServerError);
    expect(exceptionFor(418)).toBe(APIError);
  });

  it("maps the did_not_open code to GateNotOpenedError regardless of status", () => {
    expect(exceptionFor(403, "did_not_open")).toBe(GateNotOpenedError);
  });
});

describe("APIError", () => {
  it("carries the parsed envelope fields", () => {
    const e = new APIError("nope", {
      status: 403,
      code: "open_denied",
      requestId: "req_1",
      response: { error: {} },
      headers: { "x-request-id": "req_1" },
    });
    expect(e.status).toBe(403);
    expect(e.code).toBe("open_denied");
    expect(e.requestId).toBe("req_1");
    expect(e.message).toBe("nope");
    expect(e.headers["x-request-id"]).toBe("req_1");
  });

  it("formats a readable toString", () => {
    const e = new APIError("denied", { status: 403, code: "open_denied", requestId: "r1" });
    const s = e.toString();
    expect(s).toContain("[403]");
    expect(s).toContain("open_denied");
    expect(s).toContain("denied");
    expect(s).toContain("request_id=r1");
  });

  it("keeps a correct prototype chain for instanceof", () => {
    const e = new RateLimitError("slow down", { status: 429, retryAfter: 5 });
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).toBeInstanceOf(APIError);
    expect(e).toBeInstanceOf(NimbioError);
    expect(e).toBeInstanceOf(Error);
    expect(e.retryAfter).toBe(5);
    expect(e.name).toBe("RateLimitError");
  });

  it("defaults retryAfter to null when absent", () => {
    expect(new RateLimitError("x", { status: 429 }).retryAfter).toBeNull();
  });
});
