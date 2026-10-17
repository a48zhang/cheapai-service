const account='4ac5221079fd3481ce2d92f1d1e049cd';
const ids=JSON.parse(process.env.DIAGNOSTIC_REQUEST_IDS ?? '[]');
for(const id of ids) {
 if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid diagnostic ID');
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/observability/telemetry/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},body:JSON.stringify({queryId:'cheapai-diagnostic-'+id,timeframe:{from:Date.parse('2026-10-17T04:00:00Z'),to:Date.now()},view:'events',limit:20,parameters:{filterCombination:'and',filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'sub2api-cloudflare-production'}],needle:{value:id,isRegex:false}}}),signal:AbortSignal.timeout(30000)});
 let data;try{data=await response.json()}catch{}
 const markers=new Set(); const statuses=new Set();
 function inspect(v) {
   if(typeof v==='string') {
     for(const pattern of [/no such (?:table|column): [A-Za-z0-9_.]+/g,/SQLITE_[A-Z_]+/g,/D1_[A-Z_]+/g,/invalid_stored_[a-z_]+/g,/NOT NULL constraint failed: [A-Za-z0-9_.]+/g,/FOREIGN KEY constraint failed/g,/UNIQUE constraint failed: [A-Za-z0-9_.]+/g]) for(const m of v.matchAll(pattern)) markers.add(m[0]);
     for(const code of ['service_unavailable','internal_error','insufficient_balance','invalid_request','upstream_error','request_timeout','conversion_failed','upstream_failed','invalid_registry_context','output_limit_required','authentication_unavailable','Channel upstream key is missing','Gateway dispatch failed','API request failed','Stream startup failed','Expected upstream SSE','Streaming execution could not start.','network_error','headers_timeout','idle_timeout','stream_error','Upstream returned an HTTP error','Upstream fetch failed','Channel changed','Stream stopped before response publication']) if(v.includes(code)) markers.add(code);
   } else if(Array.isArray(v)) v.forEach(inspect);
   else if(v&&typeof v==='object') for(const [k,value] of Object.entries(v)) {if(['upstream_status','status','statusCode'].includes(k)&&typeof value==='number')statuses.add(value);inspect(value);}
 }
 inspect(data?.result);
 const correlations=[];
 function idsOnly(v,path='events') {
   if(Array.isArray(v)) v.forEach(x=>idsOnly(x,path+'[]'));
   else if(v&&typeof v==='object') for(const [k,value] of Object.entries(v)) {
     if((k==='requestId'||k==='invocationId'||(k==='id'&&path.endsWith('$metadata')))&&typeof value==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(value)) correlations.push({path:path+'.'+k,value});
     if(k==='timestamp'&&(typeof value==='number'||(typeof value==='string'&&/^[0-9TZ:.-]+$/.test(value)))) correlations.push({path:path+'.'+k,value});
     idsOnly(value,path+'.'+k);
   }
 } idsOnly(data?.result?.events);

 console.log(JSON.stringify({event:'exact_request_worker_logs',requestId:id,httpStatus:response.status,success:data?.success,errorCodes:(data?.errors??[]).map(e=>e.code),correlations,markers:[...markers],statuses:[...statuses],resultKeys:data?.result?Object.keys(data.result):[]}));
}
