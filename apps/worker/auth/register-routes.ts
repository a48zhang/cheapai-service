import { Hono } from "hono";
import type { Env } from "../env";
import { ApiError, apiError, apiSuccess, createRequestId } from "../http";
import { requireCsrf } from "./csrf";
import { registerUser, RegistrationRateError } from "./register";
import type { RegisterDependencies, RegisterInput } from "./register";

export const REGISTER_PATH = "/api/v1/auth/register";
export const REGISTER_BODY_MAX_BYTES = 8 * 1024;

export interface RegisterRoutesOptions<Bindings extends object = Env> {
  trustedOrigin: string;
  /** Trusted server adapter: secrets/IP must not come from JSON or arbitrary forwarding headers. */
  resolve(env: Bindings, request: Request): RegisterDependencies | Promise<RegisterDependencies>;
}

/** Count bytes actually read, regardless of missing or dishonest Content-Length. */
async function readInput(request: Request): Promise<RegisterInput> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) {
    throw new ApiError("invalid_request");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { finished = true; break; }
      if (part.value.byteLength > REGISTER_BODY_MAX_BYTES - length) throw new ApiError("payload_too_large");
      length += part.value.byteLength;
      if (part.value.byteLength > 0) chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("invalid_request");
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new ApiError("invalid_request"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalid_request");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["email", "password", "registrationCode", "emailCode"].includes(key)) ||
    typeof record.email !== "string" || typeof record.password !== "string" ||
    (Object.hasOwn(record, "registrationCode") && typeof record.registrationCode !== "string") ||
    (Object.hasOwn(record, "emailCode") && typeof record.emailCode !== "string")) throw new ApiError("invalid_request");
  return {
    email: record.email, password: record.password,
    ...(typeof record.registrationCode === "string" ? { registrationCode: record.registrationCode } : {}),
    ...(typeof record.emailCode === "string" ? { emailCode: record.emailCode } : {}),
  };
}

/** Unmounted factory: A31 owns integration with the main application. */
export function createRegisterRoutes<Bindings extends object = Env>(options: RegisterRoutesOptions<Bindings>): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError((error) => apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), createRequestId()));
  app.use("*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });
  app.post(REGISTER_PATH, requireCsrf(options.trustedOrigin), async (context) => {
    const requestId = createRequestId();
    try {
      const input = await readInput(context.req.raw);
      if (typeof options.resolve !== "function") throw new ApiError("service_unavailable");
      // Hono's conditional middleware Env type obscures the Bindings generic;
      // the application itself is declared with precisely this binding type.
      const dependencies = await options.resolve(context.env as Bindings, context.req.raw);
      const result = await registerUser(dependencies, input);
      const response = apiSuccess({
        status: "created", user: result.user, session: result.session,
        ...(result.session === "login_required" ? { next_action: "login" } : {}),
      }, requestId, 201);
      // The credential belongs only in Set-Cookie, never in the JSON envelope.
      if (result.session === "created") response.headers.set("Set-Cookie", result.setCookie);
      return response;
    } catch (error) {
      const response = apiError(error instanceof ApiError ? error : new ApiError("service_unavailable", { cause: error }), requestId);
      if (error instanceof RegistrationRateError) response.headers.set("Retry-After", Math.ceil(error.retryAfterMs / 1000).toString());
      return response;
    }
  });
  return app;
}
