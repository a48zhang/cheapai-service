import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createPlatformKey, findPlatformKeyById, PlatformKeyCreationConflict, updatePlatformKey } from '../../apps/worker/auth/key-repository';
import { listAvailableKeyGroups } from '../../apps/worker/auth/key-groups';
import { updateUser } from '../../apps/worker/admin/update-user';
import { createChannel } from '../../apps/worker/admin/channel-repository';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { testEnv } from '../helpers/database';

const now = Date.now();
let env: Env;
let encryptionKey: Uint8Array;
async function grant(groups: string[], version = 1) {
  return updateUser(testEnv.DB,'group-user',version,{allowedGroupIds:groups}, {actorId:'group-admin',operationId:crypto.randomUUID(),now:now+version});
}
async function key(groupId: string, operationId = crypto.randomUUID()) {
  const result=await createPlatformKey(testEnv.DB,'group-user',{groupId,name:'Group key',operationId},now+10);
  if(result.kind!=='created')throw Error('Expected new key');return result;
}
async function call(token: string, path='/v1/models', body?: unknown) {
  const context=createExecutionContext();
  const response=await app.fetch(new Request('https://group-console.example'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,context);
  const data=await response.json() as Record<string, any>;await waitOnExecutionContext(context);return {status:response.status,data};
}
beforeEach(async()=>{
  encryptionKey=crypto.getRandomValues(new Uint8Array(32));
  env={...testEnv,ENVIRONMENT:'local',PUBLIC_BASE_URL:'https://group-console.example',CHANNEL_ACTIVE_KEY_VERSION:'groups',CHANNEL_KEYRING_JSON:JSON.stringify({groups:btoa(String.fromCharCode(...encryptionKey))})} as Env;
  for(const group of ['gpt','claude','private'])await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,'active',1,0,0)").bind(group,group).run();
  for(const [id,role] of [['group-user','user'],['group-admin','admin']])await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at) VALUES(?,?,'test-hash',?,'active','gpt',1000000,2,60,'admin',0,0)`).bind(id,`${id}@example.invalid`,role).run();
  for(const group of ['gpt','claude']){
    const channel='channel-'+group;const model='model-'+group;
    const encrypted=await encryptChannelSecret('synthetic-group-upstream',channel,'groups',encryptionKey);
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at) VALUES(?,?,?,?,'groups','active',1,2,60,1,0,0)`).bind(channel,channel,'https://group-upstream.example.invalid',encrypted).run();
    await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)').bind(channel,group).run();
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}',1,0,64,0,0)`).bind(model).run();
    await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version) VALUES(?,?,'chat',?,'{"protocol":"chat","features":[],"maxOutputTokens":64}',1)`).bind(channel,model,'upstream-'+group).run();
  }
});

describe('administrator-granted Key groups on real D1 and Worker routing',()=>{
  it('lists only granted active groups with their models and rejects an ungranted selection',async()=>{
    expect(await listAvailableKeyGroups(testEnv.DB,'group-user')).toEqual([{id:'gpt',name:'gpt',models:['model-gpt']}]);
    await expect(key('claude')).rejects.toThrow();
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM api_keys').first('count')).toBe(0);
  });
  it('selects a non-default granted group and exposes only its models',async()=>{
    await grant(['gpt','claude']);const selected=await key('claude');
    expect(selected.key).toMatchObject({groupId:'claude',groupName:'claude',allowedModels:null});
    const result=await call(selected.token);expect(result.status).toBe(200);
    expect(result.data.data.map((m:{id:string})=>m.id)).toEqual(['model-claude']);
  });
  it('routes and settles using the Key group instead of the user default group',async()=>{
    await grant(['gpt','claude']);const selected=await key('claude');
    const upstream=vi.fn(async (_url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(init?.body as string);expect(body.model).toBe('upstream-claude');
      return Response.json({id:'group-provider-result',object:'chat.completion',created:1,model:body.model,choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:0}}});
    });vi.stubGlobal('fetch',upstream);
    const result=await call(selected.token,'/v1/chat/completions',{model:'model-claude',messages:[{role:'user',content:'test'}]});
    expect(result.status).toBe(200);expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT channel_id,billing_status FROM requests').first()).toEqual({channel_id:'channel-claude',billing_status:'settled'});
    const rejected=await call(selected.token,'/v1/chat/completions',{model:'model-gpt',messages:[{role:'user',content:'test'}]});
    expect(rejected.status).toBe(400);expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('revokes model access immediately while allowing the owner to rebind the same Key',async()=>{
    await grant(['gpt','claude']);const selected=await key('claude');await grant(['gpt'],2);
    expect((await call(selected.token)).status).toBe(401);
    expect(await findPlatformKeyById(testEnv.DB,'group-user',selected.key.id,now+20)).not.toBeNull();
    const changed=await updatePlatformKey(testEnv.DB,'group-user',selected.key.id,1,{groupId:'gpt'},now+20);
    expect(changed).toMatchObject({kind:'updated',key:{groupId:'gpt',version:2}});
    expect((await call(selected.token)).data.data.map((m:{id:string})=>m.id)).toEqual(['model-gpt']);
  });
  it('makes the selected group part of the creation idempotency identity',async()=>{
    await grant(['gpt','claude']);await key('gpt','same-operation');
    await expect(key('claude','same-operation')).rejects.toThrow(PlatformKeyCreationConflict);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM api_keys').first('count')).toBe(1);
  });
  it('rejects unauthorized grants and rolls back stale administrator updates',async()=>{
    await expect(updateUser(testEnv.DB,'group-user',1,{allowedGroupIds:['gpt','private']},{actorId:'group-user',operationId:'bad-actor',now:now+1})).rejects.toMatchObject({code:'forbidden'});
    await grant(['gpt','claude']);await expect(grant(['gpt','private'],1)).rejects.toMatchObject({code:'conflict'});
    expect((await listAvailableKeyGroups(testEnv.DB,'group-user')).map(g=>g.id).sort()).toEqual(['claude','gpt']);
  });
  it('supports unlimited concurrency and reports channel model metadata',async()=>{
    const user=await updateUser(testEnv.DB,'group-user',1,{concurrencyLimit:0},{actorId:'group-admin',operationId:'unlimited-user',now:now+1});
    expect(user.concurrency_limit).toBe(Number.MAX_SAFE_INTEGER);
    const created=await createChannel(testEnv.DB,{name:'Unlimited',baseUrl:'https://unlimited.example.invalid',upstreamKey:'test-key',concurrencyLimit:0,rpmLimit:60},{actorId:'group-admin',operationId:'unlimited-channel',now:now+1},{keyVersion:'groups',key:encryptionKey});
    expect(created).toMatchObject({concurrencyLimit:Number.MAX_SAFE_INTEGER,models:[]});
  });
});
