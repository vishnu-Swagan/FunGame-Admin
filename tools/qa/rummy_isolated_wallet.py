"""Real replica-set transaction test in a disposable DB with a DB-scoped user.

Run on the migration host. Synthetic balances only; never changes live DB flags.
No authentication, external payments or browser rendering are certified here.
"""
import asyncio,json,os,secrets,subprocess,sys,time,uuid
from pathlib import Path
from urllib.parse import quote
from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient
FEE_BPS=int(os.environ.get('QA_RUMMY_FEE_BPS','0'))
NAME='qa_rummy_'+uuid.uuid4().hex
USER='qa_runner';PASSWORD=secrets.token_urlsafe(30)
REPORT={'isolation':'disposable MongoDB database; dedicated readWrite credential scoped only to that database','real_mongo_transactions':True,'commission_bps':FEE_BPS,'checks':[]}
async def main():
 assert NAME.startswith('qa_rummy_')
 backup=json.loads(Path('/data/home/.config/chakri/mongo-backup.json').read_text())
 root=AsyncIOMotorClient(backup['uri'],serverSelectionTimeoutMS=6000)
 try:
  await root[NAME].command('createUser',USER,pwd=PASSWORD,roles=[{'role':'readWrite','db':NAME}])
  os.environ.update({k:v for k,v in dotenv_values('/data/home/.config/chakri/api.env').items() if v is not None and k not in ['MONGO_URL','DB_NAME']})
  os.environ.update({'MONGO_URL':'mongodb://'+USER+':'+quote(PASSWORD,safe='')+'@127.0.0.1:27017/?authSource='+NAME+'&replicaSet=chakri-rs','DB_NAME':NAME,'APP_ENV':'test','REAL_MONEY_ENABLED':'true','FINANCIAL_GAME_WALLET_INTEGRATED':'true','FINANCIAL_ALLOW_NON_TRANSACTIONAL_TESTS':'false'})
  sys.path.insert(0,'/data/chakri/source/backend')
  override=os.environ.get('QA_BACKEND_OVERRIDE')
  if override:
   assert override.startswith('/data/chakri/qa-')
   sys.path.insert(0,override)
  from db import db,client
  import routes_rummy as rr,financial_wallet as fw,game_wallet as gw,ledger
  from transactions import run_game_transaction
  from fastapi import HTTPException
  from unittest.mock import patch
  assert db.name==NAME
  await db.games.insert_one({'slug':'rummy','name':'Isolated QA Rummy','status':'ENABLED'})
  await fw.ensure_financial_indexes();await rr.ensure_rummy_core()
  await db.rummy_categories.update_many({}, {'$set':{'houseCommissionBps':FEE_BPS}})
  def join_request():
   return rr.JoinRequest(mode='LIVE',categoryId='LV1',acceptedHouseCommissionBps=FEE_BPS)
  fw.GAME_WALLET_INTEGRATION_READY=True;fw._READY=True;gw.install()
  clock=[time.time()];rr._epoch=lambda:clock[0]
  async def fixture(label,cash,bonus):
   u={'id':label,'display_name':'Isolated '+label,'status':'ACTIVE','role':'PLAYER','chip_balance':cash+bonus}
   await db.users.insert_one(dict(u))
   await db.wallet_accounts.insert_one({'id':'wallet-'+label,'user_id':label,'available_cash_chips':cash,'available_bonus_chips':bonus,'held_cash_chips':0,'version':1})
   return u
  async def balances(users):
   rows=[]
   for u in users:
    p=await db.users.find_one({'id':u['id']});w=await db.wallet_accounts.find_one({'user_id':u['id']})
    total=w['available_cash_chips']+w['available_bonus_chips'];assert p['chip_balance']==total
    rows.append({'user':u['id'],'cash':w['available_cash_chips'],'bonus':w['available_bonus_chips'],'mirror':total})
   return rows
  async def act(u,d,kind,action_id=None):
   return await rr.rummy_action(d['roomId'],rr.RummyAction(roomId=d['roomId'],roundId=d.get('roundId'),actionId=action_id or uuid.uuid4().hex,expectedVersion=d['version'],actionType=kind,actionPayload={},clientTimestamp=clock[0]),user=u)
  if FEE_BPS:
   u=await fixture('no-fee-consent',1000,0)
   try:await rr.rummy_join(rr.JoinRequest(mode='LIVE',categoryId='LV1'),user=u)
   except HTTPException as e:assert e.status_code==409 and e.detail['code']=='RUMMY_COMMISSION_CONFIRMATION_REQUIRED'
   else:raise AssertionError('A stale client joined without accepting the commission')
   assert (await balances([u]))[0]['cash']==1000
   assert await db.rummy_seats.count_documents({'user_id':u['id']})==0
   REPORT['checks'].append({'name':'missing fee acknowledgement fails before a stake','passed':True})
  users=[await fixture('funded-'+str(i),1000,0) for i in range(5)]
  joined=[]
  for u in users:joined.append(await rr.rummy_join(join_request(),user=u))
  room_id=joined[-1]['roomId'];assert len({x['roomId'] for x in joined})==1
  entry=joined[-1]['category']['entryChips'];assert entry==100
  rows=await balances(users);assert all(x['cash']==900 and x['bonus']==0 for x in rows)
  target=joined[-1]['scheduledStartAtEpoch']
  # Advance the isolated clock while all five normal player heartbeats remain
  # present; a single three-minute jump correctly triggers reconnect guards.
  while clock[0] < target-1:
   clock[0]=min(clock[0]+5,target-1)
   for u in users:
    current=await rr.rummy_room_state(room_id,user=u)
    await act(u,current,'HEARTBEAT')
  clock[0]=target+.1
  await rr._activate_scheduled_room(room_id)
  assert (await db.rummy_rooms.find_one({'id':room_id}))['state']=='TURN_ACTIVE'
  if FEE_BPS:
   await db.rummy_categories.update_many({}, {'$set':{'houseCommissionBps':2000}})
  for u in users[:4]:
   d=await rr.rummy_room_state(room_id,user=u)
   replay_id=uuid.uuid4().hex
   last_body=rr.RummyAction(roomId=room_id,roundId=d['roundId'],actionId=replay_id,expectedVersion=d['version'],actionType='DROP',actionPayload={},clientTimestamp=clock[0])
   if FEE_BPS and u is users[3]:
    original_credit=rr.credit_chips
    async def fail_after_payout(*a,**kw):
     await original_credit(*a,**kw);raise RuntimeError('QA after payout before fee posting')
    with patch.object(rr,'credit_chips',fail_after_payout):
     try:await rr.rummy_action(room_id,last_body,user=u)
     except RuntimeError as e:assert 'QA after payout' in str(e)
     else:raise AssertionError('Payout rollback fault did not run')
    assert await db.rummy_house_fees.count_documents({'round_id':d['roundId']})==0
    assert await db.chip_transactions.count_documents({'kind':ledger.PAYOUT,'game':'rummy'})==0
    assert all(row['cash']==900 for row in await balances(users))
    REPORT['checks'].append({'name':'fee reservation and winner credit roll back together after a payout fault','passed':True})
   response=await rr.rummy_action(room_id,last_body,user=u)
  room=await db.rummy_rooms.find_one({'id':room_id});assert room['state']=='ROUND_SETTLED'
  expected_fee=500*FEE_BPS//10000;expected_payout=500-expected_fee
  assert room['result']['payoutChips']==expected_payout
  assert room['result']['houseCommissionChips']==expected_fee
  assert room['category_snapshot']['houseCommissionBps']==FEE_BPS
  await db.rummy_categories.update_many({}, {'$set':{'houseCommissionBps':FEE_BPS}})
  rows=await balances(users);assert rows[-1]['cash']==900+expected_payout and sum(x['cash'] for x in rows)+expected_fee==5000
  payouts=await db.chip_transactions.find({'kind':ledger.PAYOUT,'game':'rummy'}).to_list(10)
  assert len(payouts)==1 and payouts[0]['amount']==expected_payout and payouts[0]['funding_allocation']['cash_chips']==expected_payout and payouts[0]['funding_allocation']['bonus_chips']==0
  again=await rr.rummy_action(room_id,last_body,user=users[3]);assert again==response
  assert await db.chip_transactions.count_documents({'kind':ledger.PAYOUT,'game':'rummy'})==1
  REPORT['checks'].append({'name':'five funded accounts; four drops; pooled settlement and exact-action retry','passed':True,'entry_each':100,'pot':500,'wallets':rows,'total_before':5000,'total_after':5000,'payout_count':1,'house_fee':expected_fee,'winner_payout':expected_payout})
  if FEE_BPS:
   fees=await db.rummy_house_fees.find({'status':'POSTED'}).to_list(10)
   assert len(fees)==1 and fees[0]['fee_chips']==expected_fee
   REPORT['checks'].append({'name':'one posted commission; frozen rate survives a category change','passed':True,'fee_chips':expected_fee})
  u=await fixture('refund',1000,0)
  d=await rr.rummy_join(join_request(),user=u);assert d['state']=='WAITING_FOR_PLAYERS'
  body=rr.RummyAction(roomId=d['roomId'],roundId=d.get('roundId'),actionId=uuid.uuid4().hex,expectedVersion=d['version'],actionType='LEAVE',actionPayload={},clientTimestamp=clock[0])
  once=await rr.rummy_action(d['roomId'],body,user=u);twice=await rr.rummy_action(d['roomId'],body,user=u);assert once==twice
  rows=await balances([u]);assert rows[0]['cash']==1000
  assert await db.chip_transactions.count_documents({'user_id':u['id'],'kind':ledger.REFUND})==1
  REPORT['checks'].append({'name':'waiting-table refund and duplicate leave','passed':True,'restored_cash':1000,'refund_count':1})
  for label,cash,bonus,code in [('bonus-only',0,1000,'RESTRICTED_BONUS_P2P_NOT_ALLOWED'),('mixed',1000,100,'RESTRICTED_BONUS_P2P_NOT_ALLOWED'),('underfunded',50,0,'RUMMY_BALANCE_TOO_LOW')]:
   u=await fixture(label,cash,bonus);before=await balances([u]);count=await db.chip_transactions.count_documents({'user_id':u['id']})
   try:await rr.rummy_join(join_request(),user=u)
   except HTTPException as e:assert e.status_code==409 and e.detail['code']==code,(e.status_code,e.detail)
   else:raise AssertionError('Ineligible join accepted')
   assert await balances([u])==before
   assert await db.chip_transactions.count_documents({'user_id':u['id']})==count
   assert await db.rummy_seats.count_documents({'user_id':u['id']})==0
   REPORT['checks'].append({'name':label+' wallet rejection rolls back','passed':True,'expected_error':code,'cash':cash,'bonus':bonus})
  u=await fixture('fault',1000,0);original=rr.debit_chips
  async def fail_after_debit(*a,**kw):
   await original(*a,**kw);raise RuntimeError('QA injected after debit')
  with patch.object(rr,'debit_chips',fail_after_debit):
   try:await rr.rummy_join(join_request(),user=u)
   except RuntimeError as e:assert 'QA injected' in str(e)
   else:raise AssertionError('Fault did not execute')
  rows=await balances([u]);assert rows[0]['cash']==1000
  assert await db.chip_transactions.count_documents({'user_id':u['id']})==0
  assert await db.rummy_seats.count_documents({'user_id':u['id']})==0
  REPORT['checks'].append({'name':'real Mongo transaction rollback after wallet debit','passed':True,'cash_restored':1000,'orphan_ledger_rows':0,'orphan_seats':0})
  if os.environ.get('QA_DECLARATION_REVIEW') == '1':
   # Deterministic, physically distinct cards in this disposable DB only.
   # This exercises declaration settlement; it is not a random-deal fairness audit.
   import rummy
   players=[await fixture('declare-'+str(i),1000,0) for i in range(5)]
   for player in players:
    joined=await rr.rummy_join(join_request(),user=player)
   rid=joined['roomId'];target=joined['scheduledStartAtEpoch']
   while clock[0] < target-1:
    clock[0]=min(clock[0]+5,target-1)
    for player in players:
     current=await rr.rummy_room_state(rid,user=player)
     await act(player,current,'HEARTBEAT')
   clock[0]=target+.1
   await rr._activate_scheduled_room(rid)
   room=await db.rummy_rooms.find_one({'id':rid});assert room['state']=='TURN_ACTIVE'
   winning_index=room['current_seat'];winner=players[winning_index]
   cards={c['id']:c for c in rummy.new_deck()}
   ids=[['D1-H-2','D1-H-3','D1-H-4'],['D1-S-5','D1-PJ','D1-S-7'],['D1-D-9','D1-C-9','D1-S-9'],['D1-D-10','D1-D-11','D1-D-12','D1-D-13']]
   hand=[cards[x] for group in ids for x in group];extra=cards['D2-C-8'];indicator=cards['D2-H-13']
   excluded={c['id'] for c in hand+[extra,indicator]}
   deck=[c for c in cards.values() if c['id'] not in excluded]
   for player in players:
    deal=hand if player is winner else [deck.pop() for _ in range(13)]
    await db.rummy_hands.update_one({'room_id':rid,'user_id':player['id']},{'$set':{'cards':deal,'groups':[], 'drawn':False,'drawn_card_id':None,'draw_source':None}})
   discard=deck.pop()
   await db.rummy_rooms.update_one({'id':rid},{'$set':{'wild_rank':13,'wild_joker':indicator,'closed_deck':deck+[extra],'discard_pile':[discard]}})
   d=await rr.rummy_room_state(rid,user=winner);assert len(d['privateState']['cards'])==13
   other=next(p for p in players if p is not winner)
   private=await rr.rummy_room_state(rid,user=other)
   assert not ({c['id'] for c in hand}&{c['id'] for c in private['privateState']['cards']})
   assert all('cards' not in row for row in private['seats'])
   await rr.rummy_action(rid,rr.RummyAction(roomId=rid,roundId=d['roundId'],actionId=uuid.uuid4().hex,expectedVersion=d['version'],actionType='DRAW_CLOSED',actionPayload={},clientTimestamp=clock[0]),user=winner)
   d=await rr.rummy_room_state(rid,user=winner);assert len(d['privateState']['cards'])==14
   body=rr.RummyAction(roomId=rid,roundId=d['roundId'],actionId=uuid.uuid4().hex,expectedVersion=d['version'],actionType='DISCARD_AND_DECLARE',actionPayload={'cardId':extra['id'],'groups':ids},clientTimestamp=clock[0])
   result=await rr.rummy_action(rid,body,user=winner)
   assert result['code']=='VALID_DECLARATION'
   assert await rr.rummy_action(rid,body,user=winner)==result
   settled=await db.rummy_rooms.find_one({'id':rid});assert settled['state']=='ROUND_SETTLED'
   fee=500*FEE_BPS//10000;payout=500-fee
   assert settled['result']['payoutChips']==payout and settled['result']['houseCommissionChips']==fee
   balances_after=await balances(players)
   assert sum(row['cash'] for row in balances_after)+fee==5000
   assert balances_after[winning_index]['cash']==900+payout
   assert await db.chip_transactions.count_documents({'user_id':winner['id'],'ref':d['roundId'],'kind':ledger.PAYOUT})==1
   if FEE_BPS:assert await db.rummy_house_fees.count_documents({'round_id':d['roundId'],'status':'POSTED','fee_chips':fee})==1
   REPORT['checks'].append({'name':'five-player funded valid-declaration settlement after draw/discard; private hands and exact retry','passed':True,'fixture':'authored valid hand in disposable DB, not natural random gameplay','cards_before_draw':13,'cards_after_draw':14,'cards_after_discard':13,'gross_pot':500,'house_fee':fee,'winner_payout':payout,'balances':balances_after,'initial_player_total':5000,'final_player_total':5000-fee,'house_total':fee,'payout_count':1,'winner_card_privacy_before_result':True})
  client.close()
 finally:
  if NAME.startswith('qa_rummy_'):
   try:await root[NAME].command('dropUser',USER)
   finally:await root.drop_database(NAME)
   REPORT['temporary_database_removed']=NAME not in await root.list_database_names()
  root.close()
try:asyncio.run(main())
except Exception as e:REPORT['error']={'type':type(e).__name__,'message':str(e)[:500]}
Path(os.environ.get('QA_REPORT_PATH','/data/chakri/rummy-isolated-wallet-results.json')).write_text(json.dumps(REPORT,indent=2))
print(json.dumps(REPORT),flush=True)
if 'error' in REPORT:sys.exit(1)
