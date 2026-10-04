import type { Gate } from './limits/gate';

/** Resource names must match wrangler.jsonc in every environment. */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  GATE: DurableObjectNamespace<Gate>;
  EMAIL?: SendEmail;
  /** Defaults to Cloudflare for existing deployments. */
  EMAIL_PROVIDER?: 'cloudflare' | 'resend';
  /** Resend sending credential; provision only as a Worker Secret. */
  RESEND_API_KEY?: string;
  ASSETS: Fetcher;
  ENVIRONMENT: 'local' | 'staging' | 'production';
  /** Trusted HTTPS console origin; never derive it from request headers. */
  PUBLIC_BASE_URL?: string;
  EMAIL_VERIFICATION_READY?: 'true' | 'false' | boolean;
  /** Standard canonical base64, at least 32 random bytes; provision as a Secret. */
  EMAIL_HMAC_KEY?: string;
  EMAIL_FROM?: string;
  /** Secret binding: JSON object mapping retained key-version names to canonical
   * standard base64 strings, each decoding to exactly 32 AES-256 key bytes.
   * Keep old versions until all channel ciphertext using them has been rotated.
   */
  CHANNEL_KEYRING_JSON?: string;
  /** Secret binding: the version used for new/rotated ciphertext; must exist in
   * CHANNEL_KEYRING_JSON. Neither value belongs in checked-in vars/defaults.
   */
  CHANNEL_ACTIVE_KEY_VERSION?: string;
}
