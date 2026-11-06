import type { Env } from '../env';
import { prepare } from '../db';
import { recover } from './repository';
import type { JobRow } from './repository';
import { enqueueImage } from './service';

/** D1 is also the outbox: repair interrupted submissions without a browser retry. */
export async function maintainImageJobs(env: Env): Promise<void> {
  const rows = (
    await prepare<JobRow>(
      env.DB,
      `SELECT * FROM image_generations
    WHERE (status='generating' AND (started_at IS NULL OR expires_at<=?))
       OR (status='completed' AND billing_status='pending')
    ORDER BY updated_at,id LIMIT 20`,
      [Date.now()],
    ).all()
  ).rows;
  for (const row of rows) {
    if (row.status === 'generating' && row.started_at !== null) {
      // Retry the existing alarm to recover a saved asset before declaring delivery failure.
      await enqueueImage(env, row);
      continue;
    }
    const current = await recover(env.DB, row, Date.now());
    if (
      current.status === 'generating' &&
      current.started_at === null &&
      current.execution_snapshot
    )
      await enqueueImage(env, current);
  }
}
