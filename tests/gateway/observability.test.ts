import { describe, expect, it, vi } from 'vitest';
import { createRequestObserver } from '../../apps/worker/gateway/observability';
import type { ObservationDetails, RequestObservation } from '../../apps/worker/gateway/observability';

const identity = () => ({ id: crypto.randomUUID(), public_model_id: 'vendor/model', channel_id: 'channel-1', downstream_protocol: 'chat' as const, upstream_protocol: 'messages' as const });

describe('bounded redacted request telemetry', () => {
  it('correlates stages by one internal request UUID and measures durations', () => {
    let now = 1000; const records: RequestObservation[] = []; const request = identity();
    const observer = createRequestObserver(request, { sink: record => records.push(record), now: () => now });
    now += 5; observer.mark('admitted'); now += 10; observer.mark('first_byte'); now += 20; observer.finish({ terminal: { status: 'completed', reason: 'stop' } });
    expect(records.map(record => record.request_id)).toEqual(Array(4).fill(request.id));
    expect(records.map(record => record.elapsed_ms)).toEqual([0, 5, 15, 35]);
    expect(records.map(record => record.stage_elapsed_ms)).toEqual([0, 5, 10, 20]);
    expect(records[3]?.terminal_status).toBe('completed');
  });

  it('projects usage counts without raw payloads, prompts, headers or error strings', () => {
    const records: RequestObservation[] = []; const request = identity();
    const observer = createRequestObserver(request, { sink: record => records.push(record), now: () => 1000 });
    observer.finish({ terminal: { status: 'failed', error: { kind: 'stream_error', code: 'sk-provider-secret', message: 'private prompt error' } },
      usage: { protocol: 'messages', quality: 'partial', counts: { inputTokens: 7 }, semantics: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown', cacheWriteTtl: 'unknown' },
        sources: [{ protocol: 'messages', path: 'usage', raw: { api_key: 'sk-private', prompt: 'private prompt' } }], issues: ['private error detail'] },
      prompt: 'private prompt', password: 'private password', headers: { Authorization: 'Bearer secret' }, output: 'private output',
    } as ObservationDetails);
    const result = records[1]!;
    expect(result.input_tokens).toBe(7); expect(result).not.toHaveProperty('output_tokens'); expect(result).not.toHaveProperty('cost_units');
    expect(result.anomalies).toContain('usage_unreliable');
    expect(JSON.stringify(records)).not.toMatch(/private|secret|Authorization|prompt|password|api_key/);
  });

  it('exposes accounting uncertainty, pending settlement and negative balance without inventing zero cost', () => {
    const records: RequestObservation[] = []; const request = identity();
    createRequestObserver(request, { sink: record => records.push(record), now: () => 1000 }).finish({ balanceUnits: '-9007199254740991',
      finalization: { requestId: request.id, usageQuality: 'partial', billingStatus: 'settlement_pending', accounting: 'recovered', uncertain: true, errors: ['sensitive error ignored'] } });
    const result = records[1]!;
    expect(result.balance_units).toBe('-9007199254740991'); expect(result).not.toHaveProperty('cost_units');
    expect(result.anomalies).toEqual(expect.arrayContaining(['usage_unreliable', 'settlement_pending', 'accounting_uncertain', 'negative_balance']));
  });

  it('retains explicitly known zero and exact positive money strings', () => {
    const records: RequestObservation[] = [];
    createRequestObserver(identity(), { sink: record => records.push(record), now: () => 1000 }).finish({ costUnits: '0', balanceUnits: '9007199254740991' });
    expect(records[1]).toMatchObject({ cost_units: '0', balance_units: '9007199254740991' });
  });

  it('drops malformed money and credential-shaped IDs', () => {
    const records: RequestObservation[] = [];
    createRequestObserver({ ...identity(), public_model_id: 'sk-credential' }, { sink: record => records.push(record), now: () => 1000 })
      .finish({ costUnits: 'NaN', balanceUnits: '1e20', upstreamRequestId: 's2a_key_secret' });
    expect(records[1]).not.toHaveProperty('cost_units'); expect(records[1]).not.toHaveProperty('balance_units');
    expect(records[1]).not.toHaveProperty('upstream_request_id'); expect(records[1]).not.toHaveProperty('public_model_id');
    expect(JSON.stringify(records)).not.toMatch(/credential|s2a_key|NaN|1e20/);
  });

  it('does not invoke getters/toJSON while sanitizing observation details', () => {
    const getter = vi.fn(() => { throw new Error('secret getter'); }); const records: RequestObservation[] = [];
    const details = Object.defineProperty({ toJSON: getter }, 'usage', { get: getter, enumerable: true });
    createRequestObserver(identity(), { sink: record => records.push(record), now: () => 1000 }).finish(details as ObservationDetails);
    expect(getter).not.toHaveBeenCalled(); expect(records).toHaveLength(2);
  });

  it('ignores duplicate stages and stops all emissions after completion', () => {
    const sink = vi.fn(); const observer = createRequestObserver(identity(), { sink, now: () => 1000 });
    expect(observer.mark('first_byte')).toBe(true); expect(observer.mark('first_byte')).toBe(false);
    expect(observer.finish()).toBe(true); expect(observer.finish()).toBe(false); expect(observer.mark('settlement')).toBe(false);
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it('does not allow sink/clock failures or regressions to affect the request', () => {
    const observer = createRequestObserver(identity(), { sink: () => { throw new Error('sink unavailable'); }, now: () => 1000 });
    expect(() => observer.finish()).not.toThrow();
    const clock = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(999).mockImplementation(() => { throw new Error('clock'); });
    const other = createRequestObserver(identity(), { sink: () => {}, now: clock });
    expect(other.mark('admitted')).toBe(false); expect(other.finish()).toBe(false);
  });

  it('does not attach a different request finalization or converted-protocol usage', () => {
    const records: RequestObservation[] = [];
    createRequestObserver(identity(), { sink: record => records.push(record), now: () => 1000 }).finish({
      usage: { quality: 'missing', protocol: 'chat' },
      finalization: { requestId: crypto.randomUUID(), usageQuality: 'complete', billingStatus: 'settled', accounting: 'settled', uncertain: false, errors: [] },
    });
    expect(records[1]).not.toHaveProperty('billing_status');
    expect(records[1]?.anomalies).toEqual(expect.arrayContaining(['finalization_request_mismatch', 'usage_protocol_mismatch']));
  });

  it('contains asynchronous sink rejections without awaiting telemetry delivery', async () => {
    const sink = vi.fn(async () => { throw new Error('remote logging unavailable'); });
    const observer = createRequestObserver(identity(), { sink, now: () => 1000 });
    expect(observer.finish()).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
