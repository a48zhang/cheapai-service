import { ApiClientError } from '@cheapai/api-client/errors';

// POST /channels allocates a new UUID each time and has no idempotency contract.
// Only local request failures and explicit pre-write rejections permit a retry.
export function channelCreationMayHaveSucceeded(cause: unknown): boolean {
  if (!(cause instanceof ApiClientError)) return true;
  if (cause.kind === 'request') return false;
  return !(
    cause.kind === 'api' &&
    cause.status !== null &&
    [400, 401, 403, 413, 429].includes(cause.status)
  );
}

export const uncertainChannelCreationMessage =
  '渠道创建结果不明，可能已经保存。已保留输入并停止重试，以免创建重复渠道。请在新标签页核对渠道列表和审计记录；确认结果后再刷新此页。不要直接重新创建。';
