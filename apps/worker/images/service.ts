import type { ImageGenerateInput, ImageJob } from '@cheapai/contracts/images';
import type { Env } from '../env';
import { ApiError } from '../http';
import { prepare } from '../db';
import { readChannelForForwarding } from '../catalog/channels';
import { acquireDualLease } from '../limits/dual-lease';
import { UNLIMITED_RPM } from '../config';
import { generateImage, ImageProviderError } from './provider';
import {
  authorize,
  byOperation,
  jobView,
  markFailure,
  recover,
  register,
  verifyReplay,
} from './repository';
import type { JobRow, SelectionRow } from './repository';

/** One explicit user operation yields at most one upstream request. Replays only read its result. */
export async function startImage(
  env: Env,
  userId: string,
  input: ImageGenerateInput,
  options: { now?: () => number } = {},
): Promise<ImageJob> {
  const now = options.now ?? Date.now;
  const known = await byOperation(env.DB, userId, input.operationId);
  if (known) {
    verifyReplay(known, input);
    return jobView(known);
  }
  if (!env.IMAGE_ASSETS || !env.IMAGE_JOBS) throw new ApiError('service_unavailable');
  const config = await authorize(env.DB, userId, input);
  const channel = await readChannelForForwarding(env.DB, config.channel_id);
  if (!channel || channel.status !== 'active' || channel.configVersion !== config.channel_version)
    throw new ApiError('conflict');
  const accepted = await register(env.DB, userId, input, config, crypto.randomUUID(), now());
  await enqueueImage(env, accepted.row);
  return jobView(accepted.row);
}

export async function enqueueImage(env: Env, row: JobRow): Promise<void> {
  if (!env.IMAGE_JOBS) throw new ApiError('service_unavailable');
  await env.IMAGE_JOBS.getByName(row.id).schedule(row.id, row.user_id);
}

/** Called only by a durable alarm. A persisted claim fences retries before upstream I/O. */
export async function executeImage(
  env: Env,
  row: JobRow,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  if (row.status !== 'generating' || !row.execution_snapshot) return;
  if (row.started_at !== null) {
    await markFailure(env.DB, row, 'delivery_failed', now());
    return;
  }
  if (row.expires_at <= now()) {
    await recover(env.DB, row, now());
    return;
  }
  const config: SelectionRow = JSON.parse(row.execution_snapshot);
  const userId = row.user_id;
  const id = row.id;
  const input: ImageGenerateInput = {
    operationId: row.operation_id,
    modelId: row.model_id,
    groupId: row.group_id,
    prompt: row.prompt,
    size: row.size,
  };
  const channel = await readChannelForForwarding(env.DB, config.channel_id);
  if (
    !env.IMAGE_ASSETS ||
    !channel ||
    channel.status !== 'active' ||
    channel.configVersion !== config.channel_version
  ) {
    await markFailure(env.DB, row, 'provider_unavailable', now());
    return;
  }
  const limits = (limit: number, rpm: number) => ({
    limit,
    ttlMs: 210_000,
    ...(rpm === UNLIMITED_RPM ? {} : { rate: { limit: rpm, windowMs: 60_000 } }),
  });
  const acquired = await acquireDualLease(env.GATE, {
    userId,
    channelId: config.channel_id,
    requestId: id,
    user: limits(config.user_concurrency, config.user_rpm),
    channel: limits(config.channel_concurrency, config.channel_rpm),
  });
  if (!acquired.granted) {
    await markFailure(env.DB, row, 'provider_unavailable', now());
    return;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 180_000);
  try {
    const claimed = await prepare(
      env.DB,
      "UPDATE image_generations SET started_at=?,expires_at=? WHERE id=? AND status='generating' AND started_at IS NULL AND expires_at>?",
      [now(), now() + 210_000, row.id, now()],
    ).run();
    if (claimed.changes !== 1) return;
    let stage: 'provider' | 'storage' | 'record' = 'provider';
    try {
      const result = await generateImage(
        options.fetch ?? fetch,
        channel,
        config,
        input,
        abort.signal,
      );
      stage = 'storage';
      const key = `images/${userId}/${row.id}`;
      await env.IMAGE_ASSETS.put(key, result.bytes, {
        httpMetadata: { contentType: result.mediaType },
        customMetadata: { owner: userId, generation: row.id },
      });
      stage = 'record';
      const completed = await prepare(
        env.DB,
        `UPDATE image_generations SET status='completed',error=NULL,asset_key=?,media_type=?,billing_status='pending',updated_at=? WHERE id=? AND user_id=? AND status='generating'`,
        [key, result.mediaType, now(), row.id, userId],
      ).run();
      if (completed.changes !== 1) {
        // A deadline already closed this job. Never revive it or charge for a late result.
        await env.IMAGE_ASSETS.delete(key);
        return;
      }
    } catch (error) {
      const reason =
        error instanceof ImageProviderError
          ? error.reason
          : stage === 'storage'
            ? 'storage_unavailable'
            : 'delivery_failed';
      await markFailure(env.DB, row, reason, now());
    }
  } finally {
    clearTimeout(timer);
    await acquired.lease.release();
  }
}
