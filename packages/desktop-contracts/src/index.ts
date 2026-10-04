/** Amounts from Worker management APIs are decimal strings; never coerce them to Number. */
export type AmountString = string;

/** Worker management API envelopes. These do not describe native /v1 model responses or streams. */
export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly request_id: string;
}

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'insufficient_balance'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'
  | 'service_unavailable';

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
  readonly request_id: string;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Public Worker user projection. Field names match the existing API DTO. */
export interface DesktopPublicUser {
  readonly id: string;
  readonly email_normalized: string;
  readonly role: 'user' | 'admin';
  readonly status: 'active' | 'disabled';
  readonly group_id: string;
  readonly group_status: 'active' | 'disabled';
  readonly balance_units: AmountString;
  readonly email_verified_at: number | null;
}

export interface DesktopBalance {
  readonly currency: 'USD';
  readonly decimals: 8;
  readonly balance_units: AmountString;
  readonly balance_usd: AmountString;
}

export interface DesktopAccountData {
  readonly user: DesktopPublicUser;
  readonly balance: DesktopBalance;
}

export interface DesktopLoginRequest {
  readonly email: string;
  /** Password is used only for this login request and must not enter page state. */
  readonly password: string;
}

/** Private response: contains a bearer credential and must stay inside Runtime/host. */
export interface DesktopLoginResponse {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: DesktopPublicUser;
}

/** Private response: contains the API Key used by Runtime for model requests. */
export interface DesktopKeyResponse {
  readonly key: string;
  readonly keyId: string;
  readonly expiresAt: number;
}

export type DesktopAccountProblem =
  | 'network'
  | 'serviceUnavailable'
  | 'sessionExpired'
  | 'keyRevoked'
  | 'insufficientBalance'
  | 'groupUnavailable';

/** Safe renderer projection. Credentials are deliberately absent from every branch. */
export type DesktopPublicAccountState =
  | { readonly status: 'signedOut' }
  | { readonly status: 'restoring' }
  | {
      readonly status: 'signedIn';
      readonly account: DesktopAccountData;
      readonly expiresAt: number;
    }
  | {
      readonly status: 'unavailable';
      /** Keep a last known public projection visible through recoverable failures. */
      readonly account: DesktopAccountData | null;
      readonly expiresAt: number | null;
      readonly problem: DesktopAccountProblem;
    };

/** Bootstrap message sent by the native host when it starts the local Runtime. */
export interface HostStartupEvent {
  readonly type: 'host.startup';
  readonly source: 'development' | 'sidecar';
  readonly runtime: 'bun' | 'node';
}
