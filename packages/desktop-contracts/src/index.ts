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

/** Sensitive credential received from or returned to the native host over the
 * private Runtime pipe. The native host owns OS keychain persistence; this
 * value must never be copied into a renderer event or public account state.
 */
export interface DesktopPrivateSessionCredential {
  readonly token: string;
  readonly expiresAt: number;
}

/** Host-to-Runtime private account operation payloads. A restore payload is
 * read by the native host from its credential store; a login result is returned
 * privately so the native host can save the new session before publishing UI state.
 */
export interface DesktopHostAccountPayloadByOperation {
  readonly login: DesktopLoginRequest;
  readonly restore: DesktopPrivateSessionCredential;
  readonly getAccount: DesktopPrivateSessionCredential;
  readonly getKey: DesktopPrivateSessionCredential;
  readonly logout: DesktopPrivateSessionCredential;
}

export type DesktopHostAccountOperation = keyof DesktopHostAccountPayloadByOperation;

export type DesktopHostAccountRequest = {
  [Operation in DesktopHostAccountOperation]: {
    readonly operation: Operation;
    readonly payload: DesktopHostAccountPayloadByOperation[Operation];
  }
}[DesktopHostAccountOperation];

/** Restore returns a safe projection; only the login result includes a new
 * Token and only the getKey result includes an API Key. Both travel solely on
 * the private native-host pipe, never in DesktopPublicAccountState.
 */
export interface DesktopHostAccountResultByOperation {
  readonly login: DesktopLoginResponse;
  readonly restore: DesktopPublicAccountState;
  readonly getAccount: DesktopAccountData;
  readonly getKey: DesktopKeyResponse;
  readonly logout: { readonly loggedOut: true };
}

export type DesktopHostAccountResult = {
  [Operation in DesktopHostAccountOperation]: {
    readonly operation: Operation;
    readonly result: DesktopHostAccountResultByOperation[Operation];
  }
}[DesktopHostAccountOperation];

/** Public account state notification sent only from Runtime to its native host.
 * The host may forward it to the renderer after preserving this projection.
 */
export interface DesktopRuntimeAccountStateEvent {
  readonly type: 'runtime.event';
  readonly event: 'account-state';
  readonly state: DesktopPublicAccountState;
}

/** Bootstrap message sent by the native host when it starts the local Runtime. */
export interface HostStartupEvent {
  readonly type: 'host.startup';
  readonly source: 'development' | 'sidecar';
  readonly runtime: 'bun' | 'node';
}
