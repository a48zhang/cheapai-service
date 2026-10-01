"""Local-only HTTPS product contracts; any missing business route fails the run."""
import datetime
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')

root=Path(__file__).resolve().parents[1]
out=root/'.wrangler'/'integration-audit'
out.mkdir(parents=True,exist_ok=True)
node_path=os.environ.get('SUB2API_TEST_NODE') or shutil.which('node')
if not node_path: raise SystemExit('Node is required; use the version in package.json engines.')
node=Path(node_path)
expected_node=json.loads((root/'package.json').read_text(encoding='utf-8'))['engines']['node']
actual_node=subprocess.check_output([str(node),'--version'],text=True).strip().removeprefix('v')
if actual_node != expected_node: raise SystemExit(f'Expected Node {expected_node}, received {actual_node}; set SUB2API_TEST_NODE or Path.')
wrangler=root/'apps/worker/node_modules/wrangler/bin/wrangler.js'
old_path=next(v for k,v in os.environ.items() if k.lower()=='path')
env={k:v for k,v in os.environ.items() if k.lower()!='path'}
env['Path']=str(node.parent)+os.pathsep+old_path
env['WRANGLER_LOG_PATH']=str(out/'https-wrangler.log')
env['WRANGLER_SEND_METRICS']='false'
state=out/('local-state-'+uuid.uuid4().hex[:8])
config=root/'apps/worker/wrangler.jsonc'
command=[str(node),str(wrangler)]
flags=subprocess.CREATE_NO_WINDOW

def local_d1(args,log_name):
 with (out/log_name).open('w',encoding='utf-8') as log:
  r=subprocess.run(command+['d1']+args+['--local','--persist-to',str(state),'--config',str(config)],cwd=root,env=env,input='y\n',text=True,stdout=log,stderr=subprocess.STDOUT,timeout=180,creationflags=flags)
 if r.returncode: raise RuntimeError(f'Local D1 failed: {log_name}, exit {r.returncode}')
 return r.returncode

migration_exit=local_d1(['migrations','apply','sub2api-cloudflare-local'],'https-migrations.log')
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
base=f'https://127.0.0.1:{port}'
# Only this ephemeral loopback server uses a development self-signed certificate.
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
results=[]

def request(path,method='GET',body=None,headers=None):
 assert path.startswith('/') and not path.startswith('//')
 h={'Accept':'application/json','Origin':base}
 h.update(headers or {})
 data=None
 if body is not None:
  data=json.dumps(body).encode(); h['Content-Type']='application/json'
 req=urllib.request.Request(base+path,data=data,method=method,headers=h)
 try: res=opener.open(req,timeout=30)
 except urllib.error.HTTPError as error: res=error
 with res: return res.status,dict(res.headers),res.read().decode('utf-8',errors='replace')

def header(headers,name):
 return next((v for k,v in headers.items() if k.lower()==name.lower()),'')

def registration_contract(status,headers,body):
 user=json.loads(body)['data']['user']
 attrs=[v.strip().lower() for v in header(headers,'Set-Cookie').split(';')[1:]]
 facts={'user_id_present':bool(user.get('id')),'email_present':bool(user.get('email_normalized')),'cookie_attributes':attrs}
 print(json.dumps({'registration_contract_facts':facts},ensure_ascii=False))
 return bool(user.get('id')) and bool(user.get('email_normalized')) and all(flag in attrs for flag in ['secure','httponly','samesite=lax'])

def check(label,path,method='GET',body=None,expected=(200,),headers=None,content_type='application/json',verify=None,category='contract'):
 status,h,text=request(path,method,body,headers)
 passed=status in expected and content_type in header(h,'content-type')
 if verify is not None:
  try: passed=bool(passed and verify(status,h,text))
  except (KeyError,TypeError,ValueError): passed=False
 result={'case':label,'category':category,'method':method,'path':path,'expected_statuses':list(expected),'actual_status':status,'pass':passed,'content_type':header(h,'content-type')}
 if not passed:
  try: result['error_code']=json.loads(text).get('error',{}).get('code')
  except ValueError: result['error_code']='non_json_response'
 results.append(result)
 return status,h,text

with (out/'https-server.log').open('w',encoding='utf-8') as log:
 proc=subprocess.Popen(command+['dev','--local','--ip','127.0.0.1','--port',str(port),'--local-protocol','https','--persist-to',str(state),'--config',str(config),'--var','PUBLIC_BASE_URL:'+base,'--var','EMAIL_VERIFICATION_READY:false'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=flags)
 try:
  for attempt in range(100):
   if proc.poll() is not None: raise RuntimeError('Local Worker exited before readiness; see https-server.log')
   try:
    if request('/healthz')[0]==200: break
   except (OSError,ValueError): pass
   time.sleep(.5)
  else: raise RuntimeError('HTTPS Worker did not become ready')

  check('liveness','/healthz',category='infrastructure',verify=lambda s,h,t:json.loads(t)=={'status':'ok'})
  _,_,html=check('static shell','/',content_type='text/html',category='infrastructure')
  check('SPA fallback only, login UI still incomplete','/login',content_type='text/html',category='infrastructure')
  _,csrf_headers,csrf_text=check('public settings and CSRF bootstrap','/api/v1/settings/public',category='auth',verify=lambda s,h,t:json.loads(t)['data']['registrationMode']=='closed' and 'Secure' in header(h,'Set-Cookie'))
  csrf_token=json.loads(csrf_text)['data']['csrfToken']
  csrf_cookie=header(csrf_headers,'Set-Cookie').split(';')[0]
  nonce={'Cookie':csrf_cookie,'X-CSRF-Token':csrf_token}
  credentials={'email':'socket-'+uuid.uuid4().hex[:12]+'@example.invalid','password':'local-integration-password-2026'}
  check('closed registration policy','/api/v1/auth/register','POST',credentials,(403,),nonce,category='auth')
  check('nonexistent login rejects','/api/v1/auth/login','POST',credentials,(401,),nonce,category='auth')
  check('anonymous current identity','/api/v1/auth/me',expected=(401,),category='auth')
  for path in ['/api/v1/keys','/api/v1/account/balance','/api/v1/billing/entries','/api/v1/admin/channels','/api/v1/admin/users','/api/v1/admin/registration/settings','/api/v1/admin/registration/codes','/v1/models']:
   check('required protected product endpoint',path,expected=(401,403),category='missing_product_contract')
  for path,body in [('/v1/chat/completions',{'model':'probe','messages':[{'role':'user','content':'probe'}]}),('/v1/responses',{'model':'probe','input':'probe'}),('/v1/messages',{'model':'probe','max_tokens':1,'messages':[{'role':'user','content':'probe'}]})]:
   check('required authenticated generation endpoint',path,'POST',body,(401,),category='missing_product_contract')
  for path in ['/api/v1/not-implemented-probe','/v1/not-implemented-probe']:
   check('unknown API JSON404',path,expected=(404,),category='infrastructure')
  for asset in sorted(set(re.findall(r'(?:src|href)="(/assets/[^"<>]+)"',html))):
   check('built static asset',asset,content_type='',category='infrastructure')

  # Modify only this freshly created local test D1, never a deployed database.
  local_d1(['execute','sub2api-cloudflare-local','--command',"UPDATE settings SET value_json='{\"registrationMode\":\"open\",\"emailVerificationEnabled\":false}',version=version+1 WHERE key='registration'"],'https-open-registration.log')
  check('register rejects missing CSRF','/api/v1/auth/register','POST',credentials,(403,),category='auth')
  check('register rejects cross-site Origin','/api/v1/auth/register','POST',credentials,(403,),{**nonce,'Origin':'https://attacker.example'},category='auth')
  _,reg_headers,reg_text=check('open registration creates account and secure session','/api/v1/auth/register','POST',credentials,(201,),nonce,category='auth',verify=registration_contract)
  user_id=json.loads(reg_text)['data']['user']['id']
  cookie=header(reg_headers,'Set-Cookie').split(';')[0]
  session={'Cookie':cookie}
  check('registered cookie restores ordinary zero-balance identity','/api/v1/auth/me',headers=session,category='auth',verify=lambda s,h,t:json.loads(t)['data']['id']==user_id and json.loads(t)['data']['balance_units']=='0' and json.loads(t)['data']['role']=='user' and header(h,'Cache-Control')=='no-store')
  check('duplicate registration conflicts','/api/v1/auth/register','POST',credentials,(409,),nonce,category='auth')
  logout_headers={**nonce,'Cookie':csrf_cookie+'; '+cookie}
  check('logout rejects missing CSRF','/api/v1/auth/logout','POST',expected=(403,),headers=session,category='auth')
  check('failed logout preserves session','/api/v1/auth/me',headers=session,category='auth')
  check('logout revokes and clears cookie','/api/v1/auth/logout','POST',headers=logout_headers,category='auth',verify=lambda s,h,t:'Max-Age=0' in header(h,'Set-Cookie'))
  check('old session is invalid after logout','/api/v1/auth/me',expected=(401,),headers=session,category='auth')
  check('wrong password rejects','/api/v1/auth/login','POST',{**credentials,'password':'another-local-wrong-password'},(401,),nonce,category='auth')
  _,login_headers,_=check('login after logout creates fresh session','/api/v1/auth/login','POST',credentials,(200,),nonce,category='auth',verify=lambda s,h,t:json.loads(t)['data']['id']==user_id and header(h,'Set-Cookie').split(';')[0]!=cookie)
  check('fresh login restores same identity','/api/v1/auth/me',headers={'Cookie':header(login_headers,'Set-Cookie').split(';')[0]},category='auth',verify=lambda s,h,t:json.loads(t)['data']['id']==user_id)

 finally:
  if proc.poll() is None: subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,creationflags=flags)
  proc.wait(timeout=15)

report={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':'Wrangler local HTTPS, fresh local D1/DO, no external calls','migration_exit':migration_exit,'cases':results,'passed':sum(r['pass'] for r in results),'failed':sum(not r['pass'] for r in results),'construction_placeholder':'建设中' in html or '业务功能暂未开放' in html,'test_server_stopped':proc.poll() is not None}
(out/'http-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k!='cases'},ensure_ascii=False))
print(json.dumps([r for r in results if not r['pass']],ensure_ascii=False))
raise SystemExit(1 if report['failed'] else 0)
