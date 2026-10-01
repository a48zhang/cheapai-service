import { describe, expect, expectTypeOf, it } from 'vitest';
import { contentIdKey, createResponseIds, isRepresentableWireId, ResponseIdError } from '../../packages/apicompat/ids.js';
import type { ResponseIdOptions, ResponseIds } from '../../packages/apicompat/ids.js';
import type { ResponseContext } from '../../packages/apicompat/types/adapter.js';
import type { ConversionResult } from '../../packages/apicompat/types/shared.js';

// Original synthetic cases. No upstream fixtures, global state or network access.
function value<T>(result: ConversionResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const make = (options: ResponseIdOptions = { seed: 'responseA' }): ResponseIds => value(createResponseIds(options));

describe('response-local ID allocation', () => {
  it('is stable per kind/key and separates response/upstream identities', () => {
    const ids = make({ seed: 'safe_seed', upstreamResponseId: 'upstream-response' });
    expectTypeOf(ids.idFor).toEqualTypeOf<ResponseContext['idFor']>();
    expect(ids.identity).toEqual({ responseId: 'resp_safe_seed', upstreamResponseId: 'upstream-response' });
    const item = ids.idFor('item', 'same');
    const tool = ids.idFor('tool_call', 'same');
    expect(item).not.toBe(tool);
    expect(ids.idFor('item', 'same')).toBe(item);
    expect(ids.idFor('tool_call', 'same')).toBe(tool);
    expect(ids.idFor('item', 'other')).not.toBe(item);
    expect(ids.identity.responseId).not.toBe(item);
    expect(ids.identity.responseId).not.toBe(ids.identity.upstreamResponseId);
  });

  it('isolates requests and reproduces the same deterministic operation sequence', () => {
    const a = make({ seed: 'a' });
    const b = make({ seed: 'b' });
    const replay = make({ seed: 'a' });
    expect(a.idFor('item', 'first')).not.toBe(b.idFor('item', 'first'));
    expect(replay.idFor('item', 'first')).toBe(a.idFor('item', 'first'));
    a.idFor('item', 'only-a');
    expect(b.idFor('item', 'second')).toBe('item_b_1');
    expect(replay.idFor('item', 'second')).toBe('item_a_1');
    expect(a.idFor('item', 'second')).toBe('item_a_2');
  });

  it('uses indices, including zero, to keep interleaved parallel tools independent', () => {
    const ids = make();
    const left = value(contentIdKey({ outputIndex: 0, contentIndex: 0 }));
    const right = value(contentIdKey({ outputIndex: 0, contentIndex: 1 }));
    const absent = value(contentIdKey({ outputIndex: 0 }));
    expect(left).not.toBe(absent);
    expect(right).not.toBe(left);
    expect(value(contentIdKey({ outputIndex: 1, contentIndex: 0 }))).not.toBe(right);
    expect(value(ids.preserveToolCallId(left, 'call_original_left'))).toBe('call_original_left');
    expect(value(ids.preserveToolCallId(right, 'call_original_right'))).toBe('call_original_right');
    for (const key of [right, left, right, left]) {
      expect(ids.idFor('tool_call', key)).toBe(key === left ? 'call_original_left' : 'call_original_right');
    }
    expect(ids.idFor('item', left)).not.toBe(ids.idFor('tool_call', left));
  });

  it('preserves representable IDs exactly and rejects conflicting claims without mutation', () => {
    const ids = make();
    expect(value(ids.preserveToolCallId('a', 'opaque-ID_0'))).toBe('opaque-ID_0');
    expect(value(ids.preserveToolCallId('a', 'opaque-ID_0'))).toBe('opaque-ID_0');
    expect(ids.preserveToolCallId('b', 'opaque-ID_0')).toMatchObject({ ok: false, error: { code: 'id_collision' } });
    expect(ids.preserveToolCallId('a', 'other')).toMatchObject({ ok: false, error: { code: 'id_mapping_conflict' } });
    expect(ids.idFor('tool_call', 'a')).toBe('opaque-ID_0');
    expect(value(ids.preserveToolCallId('b', 'other'))).toBe('other');
  });

  it('does not rewrite an ID already published before the original arrives', () => {
    const ids = make();
    const generated = ids.idFor('tool_call', 'key');
    expect(value(ids.preserveToolCallId('key', generated))).toBe(generated);
    expect(ids.preserveToolCallId('key', 'late_original')).toMatchObject({ ok: false, error: { code: 'id_mapping_conflict' } });
    expect(ids.idFor('tool_call', 'key')).toBe(generated);
  });

  it('handles generated-name collisions and rejects cross-kind/response collisions', () => {
    const ids = make({ seed: 's' });
    value(ids.preserveToolCallId('original-a', 'item_s_0'));
    value(ids.preserveToolCallId('original-b', 'call_s_0'));
    expect(ids.idFor('item', 'new-item')).toBe('item_s_1');
    expect(ids.idFor('tool_call', 'new-tool')).toBe('call_s_1');
    expect(ids.preserveToolCallId('bad', 'item_s_1')).toMatchObject({ ok: false, error: { code: 'id_collision' } });
    expect(ids.preserveToolCallId('bad', 'resp_s')).toMatchObject({ ok: false, error: { code: 'id_collision' } });
  });

  it('bounds state while allowing replay at capacity', () => {
    const ids = make({ seed: 's', maxIds: 2 });
    const first = ids.idFor('item', 'a');
    value(ids.preserveToolCallId('b', 'original'));
    expect(ids.idFor('item', 'a')).toBe(first);
    expect(value(ids.preserveToolCallId('b', 'original'))).toBe('original');
    expect(ids.allocate('item', 'new')).toMatchObject({ ok: false, error: { code: 'id_limit_exceeded' } });
    expect(ids.preserveToolCallId('new', 'unused')).toMatchObject({ ok: false, error: { code: 'id_limit_exceeded' } });
    expect(() => ids.idFor('tool_call', 'new')).toThrow(ResponseIdError);
  });

  it('snapshots options and safely handles object-property-looking keys', () => {
    const options = { seed: 'before', upstreamResponseId: 'upstream-before', maxIds: 2 };
    const ids = make(options);
    options.seed = 'after'; options.upstreamResponseId = 'after'; options.maxIds = 100;
    expect(ids.idFor('item', '__proto__')).toBe('item_before_0');
    expect(ids.idFor('item', 'constructor')).toBe('item_before_1');
    expect(ids.identity.upstreamResponseId).toBe('upstream-before');
    expect(Object.isFrozen(ids.identity)).toBe(true);
    expect(ids.allocate('item', 'third').ok).toBe(false);
  });

  it.each(['', ' id', 'id ', '../id', '<script>', 'a\nb', 'a\n', 'a\u0000b', '工具', 'x'.repeat(129)])('rejects unrepresentable original ID %#', original => {
    const ids = make();
    expect(isRepresentableWireId(original)).toBe(false);
    const result = ids.preserveToolCallId('key', original);
    expect(result).toMatchObject({ ok: false, error: { code: 'unrepresentable_tool_call_id' } });
    expect(value(ids.preserveToolCallId('key', 'valid'))).toBe('valid');
  });

  it('accepts the maximum ID and seed lengths without truncation', () => {
    const original = 'x'.repeat(128);
    expect(value(make().preserveToolCallId('key', original))).toBe(original);
    expect(isRepresentableWireId(make({ seed: 's'.repeat(48) }).idFor('item', '0'))).toBe(true);
    expect(createResponseIds({ seed: 's'.repeat(49) }).ok).toBe(false);
  });

  it.each(['', 'x'.repeat(513), 'x\r\ny', 'x\u007fy'])('rejects invalid identity keys %# with safe errors', key => {
    const ids = make();
    expect(ids.allocate('item', key)).toMatchObject({ ok: false, error: { code: 'invalid_id_key' } });
    expect(ids.preserveToolCallId(key, 'valid').ok).toBe(false);
    try { ids.idFor('item', key); } catch (error) {
      expect(error).toBeInstanceOf(ResponseIdError);
      expect((error as ResponseIdError).message).toBe('Response identifier allocation failed.');
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, 65_537])('rejects invalid state limit %s', maxIds => {
    expect(createResponseIds({ seed: 's', maxIds }).ok).toBe(false);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid output/content index %s', index => {
    expect(contentIdKey({ outputIndex: index }).ok).toBe(false);
    expect(contentIdKey({ outputIndex: 0, contentIndex: index }).ok).toBe(false);
  });

  it('rejects invalid seeds/upstream identity without leaking raw values', () => {
    expect(createResponseIds({ seed: 'unsafe\nseed' })).toMatchObject({ ok: false, error: { code: 'invalid_id_seed' } });
    const result = createResponseIds({ seed: 'safe', upstreamResponseId: 'private\nvalue' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_upstream_response_id' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(contentIdKey({ outputIndex: Number.MAX_SAFE_INTEGER, contentIndex: 0 }).ok).toBe(true);
  });
});
