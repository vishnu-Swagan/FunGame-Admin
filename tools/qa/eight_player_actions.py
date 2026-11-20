import asyncio,json,time,uuid,secrets,sys
sys.path.insert(0,'/tmp')
from eight_player_live import Client,ROOT
USERS=json.loads((ROOT/'players.json').read_text());RESULTS=[]
async def main():
 async with Client('http://127.0.0.1:8000/api',timeout=25) as c:
  async def call(u,method,path,body=None):
   t=time.monotonic();r=await c.request(method,path,headers={'Authorization':'Bearer '+u['token']},json=body)
   d=r.json();RESULTS.append({'player':USERS.index(u)+1,'path':path,'method':method,'status':r.status_code,'latency_ms':round((time.monotonic()-t)*1000,2),'error':d.get('detail') if isinstance(d,dict) and r.status_code>=400 else None})
   return r.status_code,d
  async def timed(slug):
   path='/games/fun-roulette' if slug=='fun-roulette' else '/live/'+slug
   end=time.monotonic()+90
   while time.monotonic()<end:
    _,state=await call(USERS[0],'GET',path+'/state')
    if state.get('phase')=='BETTING' and state.get('phase_ends_in',2)>1:
     async def bet(i,u):
      body={'amount':100}
      if slug=='fun-roulette':body.update(bet_type='color',value='red' if i%2 else 'black')
      elif slug=='aviator':body.update(auto_cashout=2.0,panel=1)
      else:body['selection']={'seven-up-down':['up','down','seven'][i%3],'andar-bahar':['andar','bahar'][i%2],'keno':list(range(1,i+2)),'pappu-pictures':['umbrella','football','sun','diya','cow','bucket','blanket','top'][i],'teen-patti':['player','dealer'][i%2],'poker':['player','dealer'][i%2]}[slug]
      return await call(u,'POST',path+'/bets',body)
     placed=await asyncio.gather(*(bet(i,u) for i,u in enumerate(USERS)))
     print(json.dumps({'game':slug,'stakes_accepted':sum(s==200 for s,_ in placed),'attempted':8}),flush=True);return
    await asyncio.sleep(1)
   print(json.dumps({'game':slug,'error':'No betting window within 90s'}),flush=True)
  async def blackjack(u):
   _,d=await call(u,'POST','/blackjack/deal',{'hands':[{'bet':100}]})
   for _ in range(4):
    if d.get('status')=='done':break
    _,d=await call(u,'POST','/blackjack/action',{'action':'stand'})
  async def chicken(u):
   op=lambda:uuid.uuid4().hex
   status,p=await call(u,'POST','/live/chicken-road/prepare',{'operation_id':op()})
   if status!=200:return
   status,d=await call(u,'POST','/live/chicken-road/play',{'operation_id':op(),'commitment_id':p['commitment_id'],'client_seed':secrets.token_hex(32),'difficulty':'easy','amount':100,'rules_version':p['rules_version']})
   if status==200 and d['round']['status']=='PLAYING':
    body={'operation_id':op(),'round_id':d['round']['id'],'expected_version':d['round']['version']}
    first=await call(u,'POST','/live/chicken-road/cashout',body)
    second=await call(u,'POST','/live/chicken-road/cashout',body)
    assert first==second,'Repeated operation did not return the same receipt'
  async def rummy(u):
   status,d=await call(u,'POST','/games/rummy/join',{'categoryId':'LV1','mode':'PRACTICE'})
   if status==200:
    (ROOT/('rummy-'+str(USERS.index(u)+1)+'.json')).write_text(json.dumps(d))
    await call(u,'GET','/games/rummy/rooms/'+d['roomId']+'/state')
  tasks=[timed(g) for g in ['seven-up-down','andar-bahar','keno','pappu-pictures','teen-patti','poker','fun-roulette','aviator']]
  tasks += [blackjack(u) for u in USERS]+[chicken(u) for u in USERS]+[rummy(u) for u in USERS]
  outcomes=await asyncio.gather(*tasks,return_exceptions=True)
  exceptions=[str(x) for x in outcomes if isinstance(x,BaseException)]
  (ROOT/'action-results.json').write_text(json.dumps({'requests':RESULTS,'exceptions':exceptions}))
  print(json.dumps({'requests':len(RESULTS),'unexpected_http_failures':[r for r in RESULTS if r['status']>=400],'exceptions':exceptions}),flush=True)
asyncio.run(main())
