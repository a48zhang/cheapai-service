import type { CandidateExclusion } from './admit';
import type { UpstreamTransportError } from './transport';
import type { ChannelCooldownInput } from '../limits/cooldown';

export type RetryFailure =
  | { kind: 'busy' | 'cooldown' }
  | { kind: 'transport'; error: Pick<UpstreamTransportError, 'reason' | 'execution'> }
  | { kind: 'provider_response'; status: number; retryAfter?: string;
      /** Established by a reviewed provider contract/adapter, not HTTP status or absence of output alone. */
      execution: 'confirmed_not_executed' | 'uncertain' };
export interface RetryFacts {
  candidate: CandidateExclusion;
  registeredRequestId: string | null;
  dispatchAttempts: number;
  switchesUsed: number;
  outputStarted: boolean;
  cleanupComplete: boolean;
  failure: RetryFailure;
}
export type RetryStopReason = 'invalid_facts' | 'output_started' | 'cleanup_uncertain' | 'cancelled' | 'execution_uncertain' | 'budget_exhausted' | 'registered_candidate_busy';
interface CommonDecision {
  /** Pass only this reviewed directive to L09 recordChannelCooldown, independently of any switch. */
  cooldown: ChannelCooldownInput | null;
}
export type RetryDecision = CommonDecision & (
  | { action: 'stop'; reason: RetryStopReason }
  | { action: 'skip_unregistered_candidate'; excludeCandidates: readonly CandidateExclusion[]; switchesUsed: number }
  | { action: 'switch_unregistered_candidate'; excludeCandidates: readonly CandidateExclusion[]; switchesUsed: 1 }
  | { action: 'registered_handoff_required'; requestId: string; excludeCandidates: readonly CandidateExclusion[]; switchesUsed: 1; mayCallFreshAdmission: false }
);

/** Pure policy, no fetch/admit/DB loop. Facts must be supplied by the trusted
 * lifecycle owner. Default is one dispatch; only proof of nonexecution permits
 * one switch. A registered handoff needs a separately implemented atomic request
 * transition: never create another request row by blindly calling G03 again.
 */
export function decideCandidateRetry(facts: RetryFacts): RetryDecision {
  const stop = (reason: RetryStopReason, cooldown: ChannelCooldownInput | null = null): RetryDecision => ({ action: 'stop', reason, cooldown });
  if (!facts || !facts.candidate || typeof facts.candidate.channelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(facts.candidate.channelId)
      || facts.candidate.channelId.trim() !== facts.candidate.channelId
      || (facts.candidate.protocol !== undefined && !['chat', 'responses', 'messages'].includes(facts.candidate.protocol))
      || (facts.registeredRequestId !== null && (typeof facts.registeredRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(facts.registeredRequestId) || facts.registeredRequestId.trim() !== facts.registeredRequestId))
      || !Number.isInteger(facts.dispatchAttempts) || facts.dispatchAttempts < 0 || facts.dispatchAttempts > 2
      || !Number.isInteger(facts.switchesUsed) || facts.switchesUsed < 0 || facts.switchesUsed > 1
      || typeof facts.outputStarted !== 'boolean' || typeof facts.cleanupComplete !== 'boolean' || !facts.failure) return stop('invalid_facts');
  if (facts.registeredRequestId === null && facts.dispatchAttempts > 0) return stop('invalid_facts');
  const failure = facts.failure;
  let cooldown: ChannelCooldownInput | null = null;
  if (failure.kind === 'provider_response') {
    if (!Number.isInteger(failure.status) || failure.status < 100 || failure.status > 599 || facts.dispatchAttempts < 1
        || !['confirmed_not_executed', 'uncertain'].includes(failure.execution)
        || (failure.retryAfter !== undefined && (typeof failure.retryAfter !== 'string' || failure.retryAfter.length > 128))) return stop('invalid_facts');
    if ([401, 403, 429].includes(failure.status)) cooldown = { channelId: facts.candidate.channelId, status: failure.status,
      ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }) };
  }
  if (facts.outputStarted) return stop('output_started', cooldown);
  if (!facts.cleanupComplete) return stop('cleanup_uncertain', cooldown);
  const excludeCandidates = [{ channelId: facts.candidate.channelId,
    ...(facts.candidate.protocol === undefined ? {} : { protocol: facts.candidate.protocol }) }];
  if (failure.kind === 'busy' || failure.kind === 'cooldown') {
    if (facts.registeredRequestId !== null || facts.dispatchAttempts !== 0) return stop('registered_candidate_busy', cooldown);
    return { action: 'skip_unregistered_candidate', excludeCandidates, switchesUsed: facts.switchesUsed, cooldown };
  }
  let notExecuted = false;
  if (failure.kind === 'transport') {
    if (!failure.error || !['not_started', 'uncertain'].includes(failure.error.execution)) return stop('invalid_facts');
    if (failure.error.reason === 'cancelled') return stop('cancelled');
    // Only G02's local configuration rejection can prove no network dispatch.
    // Timeout, EOF, redirect and network errors remain uncertain regardless of a bad caller assertion.
    notExecuted = failure.error.reason === 'invalid_configuration' && failure.error.execution === 'not_started' && facts.dispatchAttempts === 0;
  } else if (failure.kind === 'provider_response') {
    // Success statuses cannot be relabeled as preexecution rejection.
    notExecuted = failure.status >= 400 && failure.execution === 'confirmed_not_executed';
  } else return stop('invalid_facts');
  if (!notExecuted) return stop('execution_uncertain', cooldown);
  if (facts.switchesUsed >= 1 || facts.dispatchAttempts >= 2) return stop('budget_exhausted', cooldown);
  if (facts.registeredRequestId !== null) return { action: 'registered_handoff_required', requestId: facts.registeredRequestId,
    excludeCandidates, switchesUsed: 1, mayCallFreshAdmission: false, cooldown };
  return { action: 'switch_unregistered_candidate', excludeCandidates, switchesUsed: 1, cooldown };
}
