import { describe, expect, it } from 'vitest';
import { decideCandidateRetry } from '../../apps/worker/gateway/retry-policy';
import type { RetryFacts } from '../../apps/worker/gateway/retry-policy';
import { recordChannelCooldown } from '../../apps/worker/limits/cooldown';
import { testEnv } from '../helpers/database';

function facts(overrides: Partial<RetryFacts> = {}): RetryFacts {
  return { candidate: { channelId: 'g12-channel', protocol: 'chat' }, registeredRequestId: null, dispatchAttempts: 0,
    switchesUsed: 0, outputStarted: false, cleanupComplete: true, failure: { kind: 'busy' }, ...overrides };
}
describe('explicit single-switch generation policy', () => {
  it('skips unregistered busy/cooldown candidates without inventing a generation retry', () => {
    for (const kind of ['busy', 'cooldown'] as const) expect(decideCandidateRetry(facts({ failure: { kind } }))).toMatchObject({ action: 'skip_unregistered_candidate', switchesUsed: 0, excludeCandidates: [{ channelId: 'g12-channel', protocol: 'chat' }] });
    expect(decideCandidateRetry(facts({ registeredRequestId: 'request-1' }))).toMatchObject({ action: 'stop', reason: 'registered_candidate_busy' });
  });
  it('never treats no output, network timeout, redirect or disconnect as nonexecution', () => {
    for (const reason of ['network_error', 'headers_timeout', 'request_timeout', 'idle_timeout', 'stream_error', 'redirect_rejected'] as const) {
      for (const execution of ['uncertain', 'not_started'] as const) expect(decideCandidateRetry(facts({ registeredRequestId: 'request-1', dispatchAttempts: 1, failure: { kind: 'transport', error: { reason, execution } } }))).toMatchObject({ action: 'stop', reason: 'execution_uncertain' });
    }
    expect(decideCandidateRetry(facts({ failure: { kind: 'transport', error: { reason: 'cancelled', execution: 'not_started' } } }))).toMatchObject({ action: 'stop', reason: 'cancelled' });
  });
  it('requires proof before one switch and refuses unsafe fresh admission for registered work', () => {
    const failure = { kind: 'provider_response' as const, status: 429, execution: 'confirmed_not_executed' as const };
    expect(decideCandidateRetry(facts({ dispatchAttempts: 1, failure }))).toMatchObject({ action: 'stop', reason: 'invalid_facts' });
    expect(decideCandidateRetry(facts({ registeredRequestId: 'request-1', dispatchAttempts: 1, failure }))).toMatchObject({ action: 'registered_handoff_required', requestId: 'request-1', mayCallFreshAdmission: false });
    expect(decideCandidateRetry(facts({ registeredRequestId: 'request-1', dispatchAttempts: 1, failure: { ...failure, execution: 'uncertain' } }))).toMatchObject({ action: 'stop', reason: 'execution_uncertain' });
    expect(decideCandidateRetry(facts({ registeredRequestId: 'request-1', dispatchAttempts: 2, switchesUsed: 1, failure }))).toMatchObject({ action: 'stop', reason: 'budget_exhausted' });
  });
  it('blocks switching after output or uncertain lease cleanup, including otherwise safe local failures', () => {
    const failure = { kind: 'transport' as const, error: { reason: 'invalid_configuration' as const, execution: 'not_started' as const } };
    expect(decideCandidateRetry(facts({ failure }))).toMatchObject({ action: 'switch_unregistered_candidate' });
    expect(decideCandidateRetry(facts({ failure, outputStarted: true }))).toMatchObject({ action: 'stop', reason: 'output_started' });
    expect(decideCandidateRetry(facts({ failure, cleanupComplete: false }))).toMatchObject({ action: 'stop', reason: 'cleanup_uncertain' });
    expect(decideCandidateRetry(facts({ switchesUsed: 2 }))).toMatchObject({ action: 'stop', reason: 'invalid_facts' });
  });
  it('returns an independent L09 cooldown directive even when retry is unsafe', async () => {
    const decision = decideCandidateRetry(facts({ registeredRequestId: 'request-1', dispatchAttempts: 1,
      failure: { kind: 'provider_response', status: 429, execution: 'uncertain', retryAfter: '999999' } }));
    expect(decision.action).toBe('stop'); expect(decision.cooldown).not.toBeNull();
    const applied = await recordChannelCooldown(testEnv.GATE, decision.cooldown!);
    expect(applied.applied).toBe(true);
    if (applied.applied) expect(applied.cooldown.retryAfterMs).toBeLessThanOrEqual(300_000);
  });
});
