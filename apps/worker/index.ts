import { app } from './app';
import { handleScheduled } from './scheduled';
import type { Env } from './env';

export { Gate } from './limits/gate';

export default { fetch: app.fetch, scheduled: handleScheduled } satisfies ExportedHandler<Env>;
