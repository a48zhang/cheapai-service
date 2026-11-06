import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { getJob, recover } from './repository';
import { executeImage } from './service';

/** Per-generation persistent wake-up; no prompt or provider secret is stored here. */
export class ImageGenerationJob extends DurableObject<Env> {
  async schedule(id: string, userId: string): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      if (await storage.get('job')) return;
      await storage.put('job', { id, userId });
      await storage.setAlarm(Date.now() + 1000);
    });
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<{ id: string; userId: string }>('job');
    if (!job) return;
    // Schedule recovery before I/O so even exhausted platform retries have a wake-up.
    await this.ctx.storage.setAlarm(Date.now() + 240_000);
    const row = await getJob(this.env.DB, job.userId, job.id);
    if (row) {
      await executeImage(this.env, row);
      const result = await getJob(this.env.DB, job.userId, job.id);
      if (result) {
        const recovered = await recover(this.env.DB, result, Date.now());
        if (recovered.billing_status === 'pending') return;
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
