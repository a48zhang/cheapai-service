import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';
import type { ImageJob, ImageModel } from '@cheapai/contracts/images';

const origin = 'https://images.example.invalid';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5kAAAAASUVORK5CYII=';
let headers: Record<string, Record<string, string>>;
let model: ImageModel;
const env = () => ({ ...testEnv, ENVIRONMENT: 'local' as const, PUBLIC_BASE_URL: origin });
async function request(
  path: string,
  actor = 'image-owner',
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(origin + path, {
      method,
      headers: headers[actor] ?? {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const input = (operationId = 'image-operation') => ({
  operationId,
  modelId: model.id,
  groupId: 'image-group',
  prompt: 'A watercolor cat',
  size: '1024x1024',
});
beforeEach(async () => {
  headers = {};
  const now = Date.now();
  await testEnv.DB.prepare(
    "INSERT INTO groups(id,name,status,version,billing_multiplier,created_at,updated_at) VALUES('image-group','Images','active',1,'0.5',?,?)",
  )
    .bind(now, now)
    .run();
  for (const [id, role] of [
    ['image-owner', 'user'],
    ['image-other', 'user'],
    ['image-admin', 'admin'],
  ] as const) {
    await testEnv.DB.prepare(
      "INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at) VALUES(?,?,'test',?,'active','image-group',0,3,60,'bootstrap',?,?)",
    )
      .bind(id, `${id}@example.invalid`, role, now, now)
      .run();
    await testEnv.DB.prepare(
      "INSERT OR IGNORE INTO user_group_access(user_id,group_id,created_at) VALUES(?,'image-group',?)",
    )
      .bind(id, now)
      .run();
    const cookie = (await createCookieSession(testEnv.DB, id, now)).setCookie.split(';')[0];
    const csrf = issueCsrfToken();
    headers[id] = {
      Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
    };
  }
  await testEnv.DB.prepare(
    "INSERT INTO billing_entries(id,operation_id,kind,user_id,delta_units,fingerprint,reason,created_by,created_at) VALUES('image-grant','image-grant','grant','image-owner',100000000,'grant','test','image-admin',?)",
  )
    .bind(now)
    .run();
  await testEnv.DB.prepare(
    "INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at) VALUES('image-channel','Images','https://provider.example.invalid/prefix/v1','test-secret','active',1,3,60,1,?,?)",
  )
    .bind(now, now)
    .run();
  await testEnv.DB.prepare(
    "INSERT INTO channel_groups(channel_id,group_id) VALUES('image-channel','image-group')",
  ).run();
  const created = await request('/api/v1/admin/image-models', 'image-admin', {
    name: 'Image model',
    channelId: 'image-channel',
    upstreamModel: 'gpt-image-test',
    pricePerImage: '0.1',
    sizes: ['1024x1024', '1536x1024'],
    quality: 'default',
    responseFormat: 'default',
    status: 'active',
  });
  expect(created.status, await created.clone().text()).toBe(201);
  model = ((await created.json()) as { data: ImageModel }).data;
});
describe('image generation through session routes, native D1, R2 and limits', () => {
  it('shows authorized prices, generates privately, and charges only once across replays', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe('https://provider.example.invalid/prefix/v1/images/generations');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-secret');
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'gpt-image-test',
        prompt: 'A watercolor cat',
        size: '1024x1024',
        n: 1,
      });
      return Response.json({ data: [{ b64_json: png }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const catalog = (await (await request('/api/v1/images/models')).json()) as {
      data: { items: unknown[] };
    };
    expect(catalog.data.items).toEqual([
      expect.objectContaining({ modelId: model.id, priceUnits: '5000000' }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain('test-secret');
    const generated = await request('/api/v1/images/generations', 'image-owner', input());
    expect(generated.status, await generated.clone().text()).toBe(200);
    const job = ((await generated.json()) as { data: ImageJob }).data;
    expect(job).toMatchObject({
      status: 'completed',
      billingStatus: 'settled',
      priceUnits: '5000000',
    });
    const replay = await request('/api/v1/images/generations', 'image-owner', input());
    expect(((await replay.json()) as { data: ImageJob }).data.id).toBe(job.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='image-owner'").first(
        'balance_units',
      ),
    ).toBe(95000000);
    const ledger = (await (
      await request('/api/v1/billing/entries?kind=image_generation')
    ).json()) as { data: { items: unknown[]; summary: unknown } };
    expect(ledger.data.items).toHaveLength(1);
    expect(ledger.data.items[0]).toMatchObject({
      kind: 'image_generation',
      imageGenerationId: job.id,
      deltaUnits: '-5000000',
      source: 'web_image',
    });
    expect(ledger.data.summary).toMatchObject({ consumptionUnits: '5000000' });
    const image = await request(`/api/v1/images/generations/${job.id}/content?download=1`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toContain('attachment');
    expect((await image.arrayBuffer()).byteLength).toBe(atob(png).length);
    expect((await request(`/api/v1/images/generations/${job.id}`, 'image-other')).status).toBe(404);
    expect(
      (await request(`/api/v1/images/generations/${job.id}/content`, 'image-other')).status,
    ).toBe(404);
  });
  it('rejects unauthorized, unconfigured, invalid-size and insufficient-balance requests before calling the provider', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await request('/api/v1/admin/image-models')).status).toBe(403);
    expect(
      (await request('/api/v1/images/generations', 'image-owner', { ...input(), size: '999x999' }))
        .status,
    ).toBe(400);
    expect((await request('/api/v1/images/generations', 'image-other', input())).status).toBe(402);
    await testEnv.DB.prepare("DELETE FROM user_group_access WHERE user_id='image-owner'").run();
    expect((await request('/api/v1/images/generations', 'image-owner', input())).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks session and CSRF and records an audited versioned configuration', async () => {
    expect((await request('/api/v1/images/models', 'anonymous')).status).toBe(401);
    const unsafe = { ...headers['image-owner'] };
    delete unsafe['X-CSRF-Token'];
    headers['unsafe'] = unsafe;
    expect((await request('/api/v1/images/generations', 'unsafe', input())).status).toBe(403);
    const { id, version, ...values } = model;
    const patch = await request(
      `/api/v1/admin/image-models/${id}`,
      'image-admin',
      { ...values, name: 'Updated image model', version },
      'PATCH',
    );
    expect(patch.status, await patch.clone().text()).toBe(200);
    expect(
      (
        await request(
          `/api/v1/admin/image-models/${id}`,
          'image-admin',
          { ...values, version },
          'PATCH',
        )
      ).status,
    ).toBe(409);
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS n FROM admin_audit WHERE target_type='image_model'",
      ).first('n'),
    ).toBe(2);
  });
  it('does not repeat an uncertain provider call when the same operation is confirmed', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('provider disconnected');
    });
    vi.stubGlobal('fetch', fetcher);
    const first = await request('/api/v1/images/generations', 'image-owner', input());
    expect(((await first.json()) as { data: ImageJob }).data).toMatchObject({
      status: 'unknown',
      error: 'result_unknown',
      billingStatus: 'unbilled',
    });
    await request('/api/v1/images/generations', 'image-owner', input());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (
        await request('/api/v1/images/generations', 'image-owner', {
          ...input(),
          prompt: 'Different prompt',
        })
      ).status,
    ).toBe(409);
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS n FROM billing_entries WHERE kind='image_generation'",
      ).first('n'),
    ).toBe(0);
  });
  it.each(['rejected', 'invalid', 'storage'] as const)(
    'keeps a recoverable record without a charge when %s',
    async (mode) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          mode === 'rejected'
            ? Response.json({ error: { message: 'private upstream details' } }, { status: 400 })
            : Response.json({
                data: [{ b64_json: mode === 'invalid' ? btoa('<svg>invalid</svg>') : png }],
              }),
        ),
      );
      if (mode === 'storage')
        vi.spyOn(testEnv.IMAGE_ASSETS!, 'put').mockRejectedValueOnce(
          new Error('storage unavailable'),
        );
      const response = await request('/api/v1/images/generations', 'image-owner', input());
      const job = ((await response.json()) as { data: ImageJob }).data;
      expect(job.status).toBe('failed');
      expect(job.billingStatus).toBe('unbilled');
      expect(
        await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='image-owner'").first(
          'balance_units',
        ),
      ).toBe(100000000);
      expect(JSON.stringify(job)).not.toContain('private upstream');
    },
  );
  it('deduplicates overlapping sends before generating and keeps immutable price snapshots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi.fn(async () => {
      entered();
      await gate;
      return Response.json({ data: [{ b64_json: png }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const first = request('/api/v1/images/generations', 'image-owner', input());
    await started;
    const second = await request('/api/v1/images/generations', 'image-owner', input());
    expect(((await second.json()) as { data: ImageJob }).data.status).toBe('generating');
    await testEnv.DB.prepare(
      'UPDATE image_models SET price_units=90000000,version=version+1 WHERE id=?',
    )
      .bind(model.id)
      .run();
    release();
    expect(((await (await first).json()) as { data: ImageJob }).data.priceUnits).toBe('5000000');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('recovers a delayed charge without regenerating or charging twice', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ b64_json: png }] }));
    vi.stubGlobal('fetch', fetcher);
    await testEnv.DB.prepare(
      `CREATE TRIGGER image_settlement_outage BEFORE INSERT ON billing_entries
      WHEN NEW.kind='image_generation' BEGIN SELECT RAISE(ABORT,'fixture outage'); END`,
    ).run();
    const response = await request('/api/v1/images/generations', 'image-owner', input());
    const job = ((await response.json()) as { data: ImageJob }).data;
    expect(job).toMatchObject({ status: 'completed', billingStatus: 'pending' });
    const stillPending = await request(`/api/v1/images/generations/${job.id}`);
    expect(((await stillPending.json()) as { data: ImageJob }).data).toMatchObject({
      status: 'completed',
      billingStatus: 'pending',
    });
    expect((await request(`/api/v1/images/generations/${job.id}/content`)).status).toBe(200);
    expect(
      await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='image-owner'").first(
        'balance_units',
      ),
    ).toBe(100000000);
    await testEnv.DB.prepare('DROP TRIGGER image_settlement_outage').run();
    for (let i = 0; i < 2; i++) {
      const restored = await request(`/api/v1/images/generations/${job.id}`);
      expect(((await restored.json()) as { data: ImageJob }).data.billingStatus).toBe('settled');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='image-owner'").first(
        'balance_units',
      ),
    ).toBe(95000000);
    expect(
      await testEnv.DB.prepare(
        "SELECT count(*) AS n FROM billing_entries WHERE kind='image_generation'",
      ).first('n'),
    ).toBe(1);
  });
});
