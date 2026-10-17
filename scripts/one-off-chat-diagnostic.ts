import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { hashPassword } from '../apps/worker/auth/password.ts';

const uid = 'diag-31ca2dc4-83a3-4e09-a94c-19c46317c654';
let chatRequestId;
const diagnosticStarted=Date.now();
const email = uid + '@example.invalid';
const password = randomBytes(32).toString('base64url');
const cookieJar = new Map();
const origin = 'https://cheapai.dev';
let created = false;
const out = (event, value) => console.log(JSON.stringify({event, ...value}));
function sql(query) {
  const file = '/tmp/cheapai-diag-' + randomUUID() + '.sql';
  writeFileSync(file, query, {mode:0o600});
  try {
    const result = execFileSync('pnpm', ['exec','wrangler','d1','execute','DB','--config','wrangler.jsonc','--env','production','--remote','--json','--command',query], {cwd:'apps/worker',encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:2000000});
    const parsed = JSON.parse(result);
    if (parsed.some(x=>x.success===false)) throw new Error('D1 query failed');
    return parsed.flatMap(x=>x.results ?? []);
  } catch { throw new Error('D1 command failed; raw output withheld'); }
  finally { unlinkSync(file); }
}
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
async function request(path, body) {
  const headers = {'User-Agent':'CheapAI-authorized-diagnostic/1.0','Origin':origin};
  if(cookieJar.size) headers.Cookie = [...cookieJar].map(([k,v])=>k+'='+v).join('; ');
  if(body) { headers['Content-Type']='application/json'; headers['X-CSRF-Token']=cookieJar.get('__Host-sub2api_csrf') ?? ''; }
  const response = await fetch(origin+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  for(const cookie of response.headers.getSetCookie()) { const pair=cookie.split(';')[0]; const i=pair.indexOf('=');cookieJar.set(pair.slice(0,i),pair.slice(i+1)); }
  return response;
}
async function jsonResponse(label,response) {
  const raw=await response.text(); let body;try{body=JSON.parse(raw)}catch{}
  out(label,{status:response.status,contentType:response.headers.get('content-type'),requestId:body?.request_id ?? response.headers.get('x-request-id'),error:body?.error?{code:body.error.code,message:body.error.message}:undefined,nonJson:!body});
  return body;
}
try {
  out('phase',{name:'read_expected_model'});
  const group=sql("SELECT g.id FROM groups g JOIN channel_groups cg ON cg.group_id=g.id JOIN channels c ON c.id=cg.channel_id JOIN channel_models cm ON cm.channel_id=c.id JOIN models m ON m.public_model_id=cm.public_model_id WHERE g.id='default' AND g.status='active' AND c.status='active' AND m.status='active' AND cm.public_model_id='gpt-5' LIMIT 1")[0];
  if(!group) throw new Error('Expected active diagnostic model missing');
  out('phase',{name:'hash_new_test_password'});
  const hash=await hashPassword(password);const now=Date.now();
  const existing=sql("SELECT id,role,status,group_id,balance_units FROM users WHERE id="+quote(uid))[0];
  if(!existing || existing.role!=='user' || existing.status!=='disabled' || existing.group_id!=='default') throw new Error('Exact temporary account state mismatch');
  const reactivated=sql("UPDATE users SET status='active',password_hash="+quote(hash)+",version=version+1,updated_at="+now+" WHERE id="+quote(uid)+" AND role='user' AND status='disabled' RETURNING id");
  created=true;
  if(reactivated.length!==1) throw new Error('Temporary account activation not confirmed');
  const req=createRequire(realpathSync('apps/worker/node_modules/wrangler/package.json'));
  req('esbuild').buildSync({entryPoints:['apps/worker/billing/fingerprint.ts'],bundle:true,platform:'node',format:'esm',outfile:'/tmp/cheapai-fingerprint.mjs',logLevel:'silent'});
  const {buildSettlementFingerprint}=await import('file:///tmp/cheapai-fingerprint.mjs');
  const operationId='diagnostic-grant-20261017-'+uid;
  const reason='User-authorized CI diagnostic internal credit USD 0.01; only this temporary ordinary account; no payment. CI operator, recorded under diagnostic identity.';
  const facts={kind:'grant',operationId,userId:uid,requestId:null,priceSnapshotJson:null,usage:null,deltaUnits:'1000000',createdBy:uid,reason};
  const fp=await buildSettlementFingerprint(facts);
  const prior=sql("SELECT delta_units,fingerprint FROM billing_entries WHERE operation_id="+quote(operationId)+" AND user_id="+quote(uid));
  if(prior.length===0) {
    sql("INSERT INTO billing_entries (id,operation_id,kind,user_id,currency,delta_units,fingerprint,created_by,reason,created_at) VALUES ("+[randomUUID(),operationId,'grant',uid,'USD'].map(quote).join(',')+",1000000,"+[fp.fingerprint,uid,reason].map(quote).join(',')+","+now+")");
  } else if(prior.length!==1 || prior[0].delta_units!==1000000 || prior[0].fingerprint!==fp.fingerprint) throw new Error('Diagnostic grant mismatch');
  out('test_credit',{userId:uid,role:'user',grantUnits:1000000,grantUsd:'0.01',operationId,balance:sql("SELECT balance_units FROM users WHERE id="+quote(uid))[0]?.balance_units});
  await jsonResponse('bootstrap',await request('/api/v1/settings/public'));
  const login=await request('/api/v1/auth/login',{email,password});await jsonResponse('login',login);
  if(!login.ok) throw new Error('Test login failed');
  const modelsResponse=await request('/api/v1/chat/models');const models=await jsonResponse('models',modelsResponse);
  out('authorized_models',{items:(models?.data?.items??[]).map(g=>({groupId:g.id,models:g.models.map(m=>m.publicModelId)}))});
  if(!modelsResponse.ok) throw new Error('Chat models failed');
  const conversationResponse=await request('/api/v1/chat/conversations',{title:'Temporary diagnostic 2026-10-17',groupId:group.id,modelId:'gpt-5'});
  const conversation=await jsonResponse('conversation',conversationResponse);
  if(!conversationResponse.ok) throw new Error('Conversation creation failed');
  const c=conversation.data;
  const response=await request('/api/v1/chat/conversations/'+encodeURIComponent(c.id)+'/messages',{operationId:randomUUID(),conversationVersion:c.version,groupId:group.id,modelId:'gpt-5',content:'Reply only OK.'});
  if(!(response.headers.get('content-type')??'').includes('text/event-stream')) {const error=await jsonResponse('chat_send',response);chatRequestId=error?.request_id??response.headers.get('x-request-id');}
  else {
    chatRequestId=response.headers.get('x-request-id');
    const text=await response.text();
    const events=text.split(/\r?\n\r?\n/).filter(Boolean).map(frame=>{
      const event=frame.match(/^event:\s*(.*)$/m)?.[1];let data;try{data=JSON.parse(frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n'))}catch{}
      return {event,code:data?.code??data?.error?.code,requestId:data?.requestId,hasText:typeof data?.text==='string'||typeof data?.delta==='string'};
    });
    out('chat_sse',{status:response.status,requestId:response.headers.get('x-request-id'),events});
  }
  out('test_requests',{rows:sql("SELECT id,source,public_model_id,upstream_protocol,execution_status,billing_status,error_code,created_at,started_at,finished_at FROM requests WHERE user_id="+quote(uid)+" ORDER BY created_at DESC LIMIT 5")});
  out('reported_request',{rows:sql("SELECT id,source,public_model_id,upstream_protocol,execution_status,billing_status,error_code,created_at,started_at,finished_at FROM requests WHERE id='b99ede31-2664-4d19-a2bf-76bf8b534c28'")});
} catch(error) {out('diagnostic_stopped',{reason:error instanceof Error?error.message:'unknown'});process.exitCode=1;}
finally {
  if(created) {
    try {sql("UPDATE users SET status='disabled',version=version+1,updated_at="+Date.now()+" WHERE id="+quote(uid)+" AND role='user'; DELETE FROM sessions WHERE user_id="+quote(uid)+";");out('cleanup',{userId:uid,disabled:true,sessionsRemoved:true,remainingBalanceUnits:sql("SELECT balance_units FROM users WHERE id="+quote(uid))[0]?.balance_units});}
    catch {out('cleanup_failed',{userId:uid});process.exitCode=1;}
  }
}
