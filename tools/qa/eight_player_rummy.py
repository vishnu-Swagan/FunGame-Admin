import asyncio,json,time,uuid,sys
sys.path.insert(0,'/tmp')
from eight_player_live import Client,ROOT
USERS=json.loads((ROOT/'players.json').read_text());RESULT={'practice':[],'live':{},'errors':[]}
async def main():
 async with Client('http://127.0.0.1:8000/api',timeout=25) as c:
  async def req(u,method,path,body=None):
   r=await c.request(method,path,headers={'Authorization':'Bearer '+u['token']},json=body);r.raise_for_status();return r.json()
  async def state(u,room):return await req(u,'GET','/games/rummy/rooms/'+room+'/state')
  async def action(u,d,kind,payload=None):
   for attempt in range(5):
    d=await state(u,d['roomId'])
    if kind!='RECONNECT':
     await req(u,'POST','/games/rummy/rooms/'+d['roomId']+'/actions',{'roomId':d['roomId'],'roundId':d.get('roundId'),'actionId':uuid.uuid4().hex,'expectedVersion':d['version'],'actionType':'RECONNECT','actionPayload':{},'clientTimestamp':time.time()})
     d=await state(u,d['roomId'])
    try:
     return await req(u,'POST','/games/rummy/rooms/'+d['roomId']+'/actions',{'roomId':d['roomId'],'roundId':d.get('roundId'),'actionId':uuid.uuid4().hex,'expectedVersion':d['version'],'actionType':kind,'actionPayload':payload or {},'clientTimestamp':time.time()})
    except RuntimeError as e:
     if 'VERSION' not in str(e) or attempt==4:raise
     await asyncio.sleep(.2)
  for i,u in enumerate(USERS):
   try:
    d=json.loads((ROOT/f'rummy-{i+1}.json').read_text());d=await state(u,d['roomId'])
    row={'player':i+1,'wallet_neutral':d['walletNeutral'],'mode':d['mode'],'draw_discard':False}
    if d['state']=='TURN_ACTIVE' and d['privateState']['canDraw']:
     await action(u,d,'DRAW_CLOSED');d=await state(u,d['roomId'])
     assert len(d['privateState']['cards'])==14
     await action(u,d,'DISCARD',{'cardId':d['privateState']['cards'][-1]['id']});d=await state(u,d['roomId'])
     assert len(d['privateState']['cards'])==13;row['draw_discard']=True
    if d['state'] not in ['ROUND_SETTLED','CANCELLED']:await action(u,d,'LEAVE')
    RESULT['practice'].append(row)
   except RuntimeError as e:
    if 'RUMMY_SEAT_INACTIVE' not in str(e):raise
    RESULT['practice'].append({'player':i+1,'mode':'PRACTICE','expired_seat_guard':True})
  for u in USERS[:5]:
   d=await req(u,'POST','/games/rummy/join',{'categoryId':'LV1','mode':'LIVE'})
   assert all(s['displayName'].startswith('QA Eight Player Audit') for s in d['seats'] if not s.get('isBot')),'Non-QA player encountered; stop without playing'
   RESULT['live']['room_id']=d['roomId']
  room=RESULT['live']['room_id'];start=time.monotonic()
  print(json.dumps({'stage':'five QA accounts joined LIVE','start_in':d.get('scheduledStartIn'),'room_state':d['state']}),flush=True)
  while d['state']=='WAITING_FOR_PLAYERS' and time.monotonic()-start<190:
   await asyncio.sleep(2)
   # Maintain all five QA seats while waiting for the normal scheduled start.
   for u in USERS[:5]:d=await state(u,room)
  assert d['state']=='TURN_ACTIVE',d['state']
  assert d['mode']=='LIVE' and not any(s.get('isBot') for s in d['seats'])
  RESULT['live'].update({'five_authenticated_accounts':True,'no_builtin_bots':True,'wallet_neutral':d['walletNeutral'],'entry_chips':d['category']['entryChips']})
  # Deterministic full settlement branch: four participants choose DROP.
  for u in USERS[:4]:
   d=await state(u,room);await action(u,d,'DROP')
  d=await state(USERS[4],room)
  RESULT['live'].update({'final_state':d['state'],'result':d.get('result'),'scenario':'four player drops; fifth wins'})
  assert d['state']=='ROUND_SETTLED',d['state']
  print(json.dumps({'rummy_live_settled':True,'mode':d['mode'],'final_state':d['state']}),flush=True)
try:asyncio.run(main())
except Exception as e:RESULT['errors'].append(str(e));print('Rummy audit failed:',str(e),flush=True)
finally:(ROOT/'rummy-results.json').write_text(json.dumps(RESULT))
