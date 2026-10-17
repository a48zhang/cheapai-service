import { buildUpstreamUrl } from '../apps/worker/gateway/upstream-url.ts';
const account='4ac5221079fd3481ce2d92f1d1e049cd', database='d85930ad-8e4f-41b7-9fb6-ddf97719e41d';
const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+database+'/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},body:JSON.stringify({sql:"SELECT r.id,r.channel_id,r.public_model_id,r.upstream_model AS recorded_upstream_model,r.upstream_protocol,c.base_url,c.status AS channel_status,c.config_version,c.updated_at AS channel_updated_at,cm.upstream_model AS current_mapping,cm.config_version AS mapping_version FROM requests r JOIN channels c ON c.id=r.channel_id LEFT JOIN channel_models cm ON cm.channel_id=r.channel_id AND cm.public_model_id=r.public_model_id AND cm.protocol=r.upstream_protocol WHERE r.id=?",params:['8e07136a-d5e0-4118-9730-ff14d57882df']}),signal:AbortSignal.timeout(30000)});
const data=await response.json();
console.log(JSON.stringify({event:'channel_metadata_read',httpStatus:response.status,success:data.success,errorCodes:(data.errors??[]).map(x=>x.code)}));
if(!response.ok||!data.success) process.exit(1);
for(const row of data.result.flatMap(x=>x.results??[])) {
 const base=new URL(row.base_url);const target=buildUpstreamUrl(row.base_url,row.upstream_protocol);
 const clean=u=>u.origin+u.pathname;
 console.log(JSON.stringify({event:'failed_request_channel_config',requestId:row.id,channelId:row.channel_id,publicModel:row.public_model_id,recordedUpstreamModel:row.recorded_upstream_model,currentMapping:row.current_mapping,protocol:row.upstream_protocol,baseUrlWithoutQuery:clean(base),actualRequestUrlWithoutQuery:clean(target),hasQuery:!!target.search,channelStatus:row.channel_status,channelConfigVersion:row.config_version,channelUpdatedAt:row.channel_updated_at,mappingVersion:row.mapping_version,pointsAtCheapai:['cheapai.dev','www.cheapai.dev','pre.cheapai.dev','sub2api-cloudflare-production.alphazhang689.workers.dev'].includes(target.hostname)}));
}
