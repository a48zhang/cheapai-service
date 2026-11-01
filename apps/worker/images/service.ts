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
  getJob,
  jobView,
  markFailure,
  recover,
  register,
  settleImage,
  verifyReplay,
} from './repository';

/** One explicit user operation yields at most one upstream request. Replays only read its result. */
export async function startImage(
  env: Env,
  userId: string,
  input: ImageGenerateInput,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<ImageJob> {
  const now = options.now ?? Date.now;
  const known = await byOperation(env.DB, userId, input.operationId);
  if (known) {
    verifyReplay(known, input);
    return jobView(await recover(env.DB, known, now()));
  }
  if (!env.IMAGE_ASSETS) throw new ApiError('service_unavailable');
  const config = await authorize(env.DB, userId, input);
  const channel = await readChannelForForwarding(env.DB, config.channel_id);
  if (!channel || channel.status !== 'active' || channel.configVersion !== config.channel_version)
    throw new ApiError('conflict');
  const id = crypto.randomUUID();
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
  if (!acquired.granted)
    throw new ApiError(
      acquired.reason === 'denied' && acquired.cleanup.complete
        ? 'rate_limited'
        : 'service_unavailable',
    );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 180_000);
  try {
    const accepted = await register(env.DB, userId, input, config, id, now());
    if (!accepted.created) return jobView(await recover(env.DB, accepted.row, now()));
    const row = accepted.row;
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
      await prepare(
        env.DB,
        `UPDATE image_generations SET status='completed',error=NULL,asset_key=?,media_type=?,billing_status='pending',updated_at=? WHERE id=? AND user_id=? AND status IN ('generating','unknown')`,
        [key, result.mediaType, now(), row.id, userId],
      ).run();
      try {
        await settleImage(env.DB, row, now());
      } catch {
        /* Result is durable; owner-scoped reads retry settlement without generating again. */
      }
    } catch (error) {
      const reason =
        error instanceof ImageProviderError
          ? error.reason
          : stage === 'storage'
            ? 'storage_unavailable'
            : 'result_unknown';
      await markFailure(env.DB, row, reason, now());
    }
    const result = await getJob(env.DB, userId, row.id);
    if (!result) throw new ApiError('service_unavailable');
    return jobView(result);
  } finally {
    clearTimeout(timer);
    await acquired.lease.release();
  }
}
