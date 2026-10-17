import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword } from '../apps/worker/auth/password.ts';

const uid = 'diag-' + randomUUID();
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
    const result = execFileSync('pnpm', ['exec','wrangler','d1','execute','DB','--config','wrangler.jsonc','--env','production','--remote','--json','--file',file], {cwd:'apps/worker',encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:2000000});
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
  const group=sql("SELECT g.id FROM groups g JOIN channel_groups cg ON cg.group_id=g.id JOIN channels c ON c.id=cg.channel_id JOIN channel_models cm ON cm.channel_id=c.id JOIN models m ON m.public_model_id=cm.public_model_id WHERE g.id='default' AND g.status='active' AND c.status='active' AND m.status='active' AND cm.public_model_id='gpt-5' LIMIT 1")[0];
  if(!group) throw new Error('Expected active diagnostic model missing');
  const hash=await hashPassword(password);const now=Date.now();
  sql("INSERT INTO users (id,email_normalized,password_hash,role,status,email_verified_at,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at) VALUES ("+[uid,email,hash,'user','active'].map(quote).join(',')+","+now+","+quote(group.id)+",0,1,10,'bootstrap',"+now+","+now+");");
  created=true;out('test_user_created',{userId:uid,role:'user',balanceUnits:0,groupId:group.id});
  await jsonResponse('bootstrap',await request('/api/v1/public/settings'));
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
  if(!(response.headers.get('content-type')??'').includes('text/event-stream')) await jsonResponse('chat_send',response);
  else {
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
    try {sql("UPDATE users SET status='disabled',version=version+1,updated_at="+Date.now()+" WHERE id="+quote(uid)+" AND role='user'; DELETE FROM sessions WHERE user_id="+quote(uid)+";");out('cleanup',{userId:uid,disabled:true,sessionsRemoved:true});}
    catch {out('cleanup_failed',{userId:uid});process.exitCode=1;}
  }
}
