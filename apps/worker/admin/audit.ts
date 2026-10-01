import { prepare } from '../db';
import type { DbStatement } from '../db';
import { ApiError } from '../http';

export interface AuditEvent {
  id?: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  operation_id: string;
  created_at: number;
  changes: unknown;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Rule = 'object' | 'integer' | 'boolean' | 'identifier' | 'models' | readonly string[];
// Explicit projection, not a denylist. Names, URLs, email addresses, arbitrary
// headers/errors and serialized *_json strings are deliberately not accepted.
// Add a reviewed field here when a new configuration needs audit visibility.
const fields: Readonly<Record<string, Rule>> = {
  before: 'object', after: 'object', changes: 'object',
  status: ['active', 'disabled', 'revoked'], role: ['user', 'admin'],
  registration_mode: ['closed', 'open', 'invite'], protocol: ['chat', 'responses', 'messages'],
  email_verification_enabled: 'boolean', credential_changed: 'boolean', password_changed: 'boolean',
  name_changed: 'boolean', base_url_changed: 'boolean',
  concurrency_limit: 'integer', rpm_limit: 'integer', priority: 'integer', version: 'integer',
  config_version: 'integer', price_version: 'integer', balance_units: 'integer', delta_units: 'integer',
  max_output_tokens: 'integer', admission_min_balance_units: 'integer',
  expires_at: 'integer', revoked_at: 'integer', quantity: 'integer',
  group_id: 'identifier', channel_id: 'identifier', public_model_id: 'identifier',
  billing_multiplier: 'identifier',
  allowed_models_json: 'models', allowed_models: 'models',
  allowed_group_ids: 'models',
};
export const AUDIT_LIMITS = Object.freeze({ depth: 6, nodes: 256, array: 32, string: 128, bytes: 8192 });

function invalid(): never { throw new ApiError('invalid_request'); }
function oversized(): never { throw new ApiError('payload_too_large'); }
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
// Read own data properties only. Never invoke getters, toJSON, toString or iterators.
function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= AUDIT_LIMITS.string
    && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
    && !/(?:s2a_(?:key|session|invite)_|sk-|bearer|-----BEGIN)/i.test(value);
}

/** Only copies reviewed structured fields; unknown objects and accessors vanish. */
export function redactAuditChanges(input: unknown): Record<string, Json> {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function visit(value: unknown, rule: Rule, depth: number): Json | undefined {
    if (++nodes > AUDIT_LIMITS.nodes || depth > AUDIT_LIMITS.depth) oversized();
    if (value === null) return rule === 'object' ? undefined : null;
    if (typeof value === 'string' && value.length > AUDIT_LIMITS.string) oversized();
    if (value !== null && typeof value === 'object') {
      if (ancestors.has(value)) invalid();
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          if (rule !== 'models' && rule !== 'object') return undefined;
          const length = data(value, 'length');
          if (typeof length !== 'number' || length > AUDIT_LIMITS.array) oversized();
          const output: Json[] = [];
          for (let index = 0; index < length; index++) {
            const item = visit(data(value, String(index)), rule === 'models' ? 'identifier' : 'object', depth + 1);
            if (item !== undefined) output.push(item);
          }
          return output;
        }
        if (!record(value)) return undefined;
        const output: Record<string, Json> = Object.create(null);
        // Scalar fields may carry { before, after } without opening arbitrary keys.
        const rules = rule === 'object' ? fields : { before: rule, after: rule };
        for (const [key, childRule] of Object.entries(rules)) {
          const child = data(value, key);
          if (child === undefined) continue;
          const cleaned = visit(child, childRule, depth + 1);
          if (cleaned !== undefined) output[key] = cleaned;
        }
        return output;
      } finally { ancestors.delete(value); }
    }
    if (rule === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    if (rule === 'boolean') return typeof value === 'boolean' ? value : undefined;
    if (rule === 'identifier') return identifier(value) ? value : undefined;
    if (Array.isArray(rule)) return typeof value === 'string' && rule.includes(value) ? value : undefined;
    return undefined;
  }
  try {
    if (!record(input)) return {};
    const output = visit(input, 'object', 0) as Record<string, Json>;
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > AUDIT_LIMITS.bytes) oversized();
    return output;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Reflection on hostile proxies may throw. Never forward their error payload.
    return invalid();
  }
}

/**
 * Builds but does not execute a statement. Put it in the SAME batch as the
 * business write. Standalone .run() is only atomic for this audit insert.
 * Actor authorization and business idempotency remain the caller's job.
 */
export function buildAuditStatement(database: D1Database, event: AuditEvent): DbStatement<{ id: string }> {
  try {
    if (!record(event)) invalid();
    const suppliedId = data(event, 'id');
    const id = suppliedId === undefined ? crypto.randomUUID() : suppliedId;
    const actor = data(event, 'actor_id');
    const action = data(event, 'action');
    const targetType = data(event, 'target_type');
    const targetId = data(event, 'target_id');
    const operationId = data(event, 'operation_id');
    const time = data(event, 'created_at');
    if (![id, actor, targetId, operationId].every(identifier)) invalid();
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(action)) invalid();
    if (typeof targetType !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(targetType)) invalid();
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0) invalid();
    const json = JSON.stringify(redactAuditChanges(data(event, 'changes')));
    return prepare<{ id: string }>(database,
      `INSERT INTO admin_audit (id, actor_id, action, target_type, target_id, redacted_change_json, operation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [id as string, actor as string, action, targetType, targetId as string, json, operationId as string, time]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalid();
  }
}
