"""Explicitly labelled synthetic-chip QA; run on the application machine only."""
import asyncio,json,time
from pathlib import Path
import urllib.request,urllib.error,types
class Response:
 def __init__(self,status,body):self.status_code=status;self.body=body
 def json(self):return json.loads(self.body)
 def raise_for_status(self):
  if self.status_code>=400:raise RuntimeError(str(self.status_code)+': '+self.body[:300].decode())
class Client:
 def __init__(self,base_url,timeout=25):self.base=base_url;self.timeout=timeout
 async def __aenter__(self):return self
 async def __aexit__(self,*args):pass
 async def request(self,method,path,headers=None,json=None):
  import json as codec
  def send():
   h=dict(headers or {});data=codec.dumps(json).encode() if json is not None else None
   if data is not None:h['Content-Type']='application/json'
   req=urllib.request.Request(self.base+path,data=data,headers=h,method=method)
   try:
    with urllib.request.urlopen(req,timeout=self.timeout) as r:return Response(r.status,r.read())
   except urllib.error.HTTPError as e:return Response(e.code,e.read())
  return await asyncio.to_thread(send)
 async def post(self,path,**kw):return await self.request('POST',path,**kw)
 async def get(self,path,**kw):return await self.request('GET',path,**kw)
httpx=types.SimpleNamespace(AsyncClient=Client)
ROOT=Path('/data/home/.config/chakri/eight-player-qa');ROOT.mkdir(mode=0o700,exist_ok=True)
async def main():
 import sys
 sys.path.insert(0,'/data/chakri/source/backend')
 from dotenv import load_dotenv
 load_dotenv('/data/home/.config/chakri/api.env')
 from db import db
 from routes_admin import admin_create_user
 from models import AdminCreateUser
 admin=await db.users.find_one({'role':'ADMIN','username':'chakri.admin'})
 assert admin is not None
 async with httpx.AsyncClient(base_url='http://127.0.0.1:8000/api',timeout=25) as c:
  users=[]
  for i in range(8):
   d=await admin_create_user(AdminCreateUser(full_name=f'QA Eight Player Audit {i+1}',starting_chips=10000,note='Synthetic QA chips only; no deposits or withdrawals. Disable after audit.'),admin=admin)
   r=await c.post('/auth/login',json={'identifier':d['username'],'password':d['password'],'login_surface':'PLAYER'})
   r.raise_for_status();s=r.json();assert s.get('access_token'),s.get('message')
   users.append({'id':d['user']['id'],'username':d['username'],'password':d['password'],'token':s['access_token']})
  f=ROOT/'players.json';f.write_text(json.dumps(users));f.chmod(0o600)
  paths={'aviator':'/live/aviator/state','fun-roulette':'/games/fun-roulette/state','blackjack':'/blackjack/state','chicken-road':'/live/chicken-road/state','rummy':'/games/rummy/categories',**{s:'/live/'+s+'/state' for s in ['seven-up-down','andar-bahar','keno','pappu-pictures','teen-patti','poker']}}
  results=[];samples={}
  async def probe(i,u):
   for game,path in paths.items():
    start=time.monotonic();r=await c.get(path,headers={'Authorization':'Bearer '+u['token']});elapsed=(time.monotonic()-start)*1000
    results.append({'player':i+1,'game':game,'status':r.status_code,'latency_ms':round(elapsed,2)})
    if i==0:samples[game]=r.json()
  await asyncio.gather(*(probe(i,u) for i,u in enumerate(users)))
  (ROOT/'state-samples.json').write_text(json.dumps(samples));(ROOT/'readiness-results.json').write_text(json.dumps(results))
  print(json.dumps({'players_created':len(users),'requests':len(results),'failures':[x for x in results if x['status']!=200],'sample_shapes':{k:list(v.keys()) if isinstance(v,dict) else 'list' for k,v in samples.items()}}),flush=True)
if __name__ == '__main__': asyncio.run(main())
