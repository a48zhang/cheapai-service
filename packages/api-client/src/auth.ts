import {
  decodeLogoutResult,
  decodePublicSettings,
  decodePublicUser,
  decodeRegistrationResult,
  decodeVerificationCodeResult,
} from '@cheapai/contracts/auth';
import { createApiClient } from './client.js';
import { readCsrfCookie } from './csrf.js';
import type { ApiClientOptions } from './types.js';
import type {
  LoginInput,
  PublicSettings,
  PublicUser,
  RegisterInput,
  RegistrationResult,
  VerificationCodeResult,
} from '@cheapai/contracts/auth';

export type {
  LoginInput,
  PublicSettings,
  PublicUser,
  RegisterInput,
  RegistrationResult,
  VerificationCodeResult,
} from '@cheapai/contracts/auth';
export type { ApiClientOptions } from './types.js';

export interface AuthApi {
  bootstrap(): Promise<PublicSettings>;
  me(): Promise<PublicUser>;
  login(input: LoginInput): Promise<PublicUser>;
  register(input: RegisterInput): Promise<RegistrationResult>;
  logout(): Promise<void>;
  sendVerificationCode(email: string): Promise<VerificationCodeResult>;
}

/**
 * Create cookie-session authentication methods without storing credentials in
 * browser storage. Concurrent callers share the in-flight public bootstrap.
 */
export function createAuthApi(options: ApiClientOptions = {}): AuthApi {
  let token: string | null = null;
  let bootstrapping: Promise<PublicSettings> | undefined;
  const client = createApiClient({
    ...options,
    getCsrfToken: () => readCsrfCookie() ?? token ?? options.getCsrfToken?.(),
  });

  function bootstrap(): Promise<PublicSettings> {
    if (!bootstrapping) {
      bootstrapping = client
        .get('/api/v1/settings/public', { decode: decodePublicSettings })
        .then((result) => {
          token = result.data.csrfToken;
          return result.data;
        })
        .finally(() => {
          bootstrapping = undefined;
        });
    }
    return bootstrapping;
  }

  async function ensureCsrf(): Promise<void> {
    if (!(readCsrfCookie() ?? token)) await bootstrap();
  }

  return Object.freeze({
    bootstrap,
    async me(): Promise<PublicUser> {
      return (await client.get('/api/v1/auth/me', { decode: decodePublicUser })).data;
    },
    async login(input: LoginInput): Promise<PublicUser> {
      await ensureCsrf();
      return (
        await client.post(
          '/api/v1/auth/login',
          {
            email: input.email,
            password: input.password,
          },
          { decode: decodePublicUser },
        )
      ).data;
    },
    async register(input: RegisterInput): Promise<RegistrationResult> {
      await ensureCsrf();
      return (
        await client.post(
          '/api/v1/auth/register',
          {
            email: input.email,
            password: input.password,
            ...(input.registrationCode === undefined
              ? {}
              : { registrationCode: input.registrationCode }),
            ...(input.emailCode === undefined ? {} : { emailCode: input.emailCode }),
          },
          { decode: decodeRegistrationResult },
        )
      ).data;
    },
    async logout(): Promise<void> {
      await ensureCsrf();
      await client.post<void>('/api/v1/auth/logout', undefined, {
        decode: (value) => {
          decodeLogoutResult(value);
          return undefined;
        },
      });
    },
    async sendVerificationCode(email: string): Promise<VerificationCodeResult> {
      await ensureCsrf();
      return (
        await client.post(
          '/api/v1/auth/send-verify-code',
          { email },
          {
            decode: decodeVerificationCodeResult,
          },
        )
      ).data;
    },
  });
}
