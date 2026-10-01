import { Hono } from 'hono';
import type { Env } from '../env';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { issueCsrfToken } from './csrf';
import { readRegistrationSettings } from './registration-settings';

export interface PublicSettingsDependencies {
  readonly database: D1Database;
  /** Trusted deployment readiness, never derived from query/body/headers. */
  readonly emailAvailable: boolean;
}
export type PublicSettingsDependencySource = PublicSettingsDependencies
  | ((env: Env, request: Request) => PublicSettingsDependencies | Promise<PublicSettingsDependencies>);
export interface PublicSettingsData {
  readonly registrationMode: 'closed' | 'open' | 'invite';
  readonly emailVerificationEnabled: boolean;
  readonly csrfToken: string;
}

/** Public anonymous bootstrap. No session is required; management writes must
 * still pass A06 Origin + CSRF validation after this endpoint supplies the nonce.
 * Mount at '/', since the complete management API path is declared here.
 */
export function createPublicSettingsRoutes(dependencies: PublicSettingsDependencySource) {
  const routes = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  routes.get('/api/v1/settings/public', async (context) => {
    const requestId = context.get('requestId') ?? createRequestId();
    let setCookie: string | undefined;
    let response: Response;
    try {
      // Validate malformed/duplicate cookies with exactly the A06 policy. Reuse
      // a valid cookie across tabs; never overwrite an ambiguous cookie header.
      const csrf = issueCsrfToken(context.req.header('Cookie') ?? null);
      setCookie = csrf.setCookie;
      const trusted = typeof dependencies === 'function' ? await dependencies(context.env, context.req.raw) : dependencies;
      const settings = await readRegistrationSettings(trusted.database, { emailAvailable: trusted.emailAvailable });
      const data: PublicSettingsData = {
        registrationMode: settings.registrationMode,
        emailVerificationEnabled: settings.emailVerificationEnabled,
        csrfToken: csrf.token,
      };
      response = apiSuccess(data, requestId);
    } catch (error) {
      // A06 malformed-cookie errors remain forbidden; storage/readiness failures
      // are service errors and must never masquerade as an open default policy.
      response = apiError(error instanceof ApiError && error.code === 'forbidden'
        ? error : new ApiError('service_unavailable'), requestId);
    }
    response.headers.set('Cache-Control', 'no-store');
    if (setCookie !== undefined) response.headers.append('Set-Cookie', setCookie);
    return response;
  });
  return routes;
}
