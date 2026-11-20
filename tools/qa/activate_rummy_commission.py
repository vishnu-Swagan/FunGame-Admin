"""Activate the user-authorized 15% fee only after code and UI deployment."""
import asyncio,hashlib,json,sys,uuid,subprocess,urllib.request
from pathlib import Path
from datetime import datetime,timezone
from dotenv import load_dotenv
load_dotenv('/data/home/.config/chakri/api.env')
sys.path.insert(0,'/data/chakri/source/backend')
from db import db,client
from transactions import run_game_transaction
from models import AdminCreateUser
from routes_admin import admin_create_user
import routes_rummy as rr
BPS=1500;REPORT={}
async def main():
 assert Path('/data/chakri/www').resolve().name=='20261120-rummy-commission','Frontend release is not active'
 expected=json.loads(Path('/tmp/rummy-commission-code-hashes.json').read_text())
 assert all(hashlib.sha256((Path('/data/chakri/source/backend')/name).read_bytes()).hexdigest()==digest for name,digest in expected.items()),'Runtime source mismatch'
 health=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=15))
 assert health['gameplay_ready'] and health['crm_ready']
 admin=await db.users.find_one({'role':'ADMIN','username':'chakri.admin'})
 assert admin,'Installation administrator missing'
 ids=['LV1','LV2','LV3','LV4','LV5']
 old_rooms=await db.rummy_rooms.find({}, {'_id':0,'id':1,'category_snapshot':1}).sort('id',1).to_list(None)
 async def configure(session):
  rows=await db.rummy_categories.find({'id':{'$in':ids}},{'_id':0},session=session).to_list(5)
  assert len(rows)==5
  before={r['id']:r.get('houseCommissionBps',0) for r in rows}
  if all(v==BPS for v in before.values()):return before
  stamp=datetime.now(timezone.utc).isoformat()
  await db.rummy_categories.update_many({'id':{'$in':ids}},{'$set':{'houseCommissionBps':BPS,'updated_at':stamp,'updated_by':admin['id']}},session=session)
  await db.admin_audit.insert_one({'id':str(uuid.uuid4()),'actor_id':admin['id'],'action':'RUMMY_COMMISSION_RATE_UPDATED','target_type':'RUMMY_CATEGORIES','target_id':'ALL_FIVE_LEVELS','before':before,'after':{k:BPS for k in ids},'metadata':{'new_tables_only':True,'user_authorized_rate_percent':15,'deposit_fee_changed':False},'created_at':stamp},session=session)
  return before
 REPORT['previous_rates_bps']=await run_game_transaction(client,configure)
 new_rooms=await db.rummy_rooms.find({'id':{'$in':[r['id'] for r in old_rooms]}},{'_id':0,'id':1,'category_snapshot':1}).sort('id',1).to_list(None)
 assert old_rooms==new_rooms,'Existing room terms changed'
 REPORT['existing_room_snapshots_unchanged']=True
 summary=await rr.admin_rummy_commission_summary(admin=admin)
 assert all(c['houseCommissionBps']==BPS for c in summary['categories'])
 REPORT['crm']=summary
 created=await admin_create_user(AdminCreateUser(full_name='QA Commission Rollout Zero Balance',starting_chips=0,note='Read-only rollout verification, no funded bets; disable after checks.'),admin=admin)
 uid=created['user']['id']
 try:
  request=urllib.request.Request('http://127.0.0.1:8000/api/auth/login',data=json.dumps({'identifier':created['username'],'password':created['password'],'login_surface':'PLAYER'}).encode(),headers={'Content-Type':'application/json'})
  login=json.load(urllib.request.urlopen(request,timeout=15));token=login['access_token']
  assert '\n' not in token and '\r' not in token
  def public(path,body=None):
   cmd=['curl','-sS','--config','-','-w','\n%{http_code}','https://chakri.casino/api'+path]
   config='header = "Authorization: Bearer '+token+'"\nuser-agent = "SKY-AMC-QA/1.0"\n'
   if body is not None:
    cmd+=['-X','POST','-H','Content-Type: application/json','--data-binary',json.dumps(body)]
   r=subprocess.run(cmd,input=config.encode(),capture_output=True,check=True,timeout=30)
   raw,code=r.stdout.rsplit(b'\n',1);return int(code),json.loads(raw)
  status,categories=public('/games/rummy/categories');assert status==200,(status,categories)
  assert len(categories['categories'])==5 and all(c.get('houseCommissionBps')==BPS for c in categories['categories'])
  status,response=public('/games/rummy/join',{'categoryId':'LV1','mode':'LIVE'})
  assert status==409 and response['detail']['code']=='RUMMY_COMMISSION_CONFIRMATION_REQUIRED',(status,response)
  status,response=public('/games/rummy/join',{'categoryId':'LV1','mode':'LIVE','acceptedHouseCommissionBps':BPS})
  assert status==409 and response['detail']['code']=='RUMMY_BALANCE_TOO_LOW',(status,response)
  assert await db.chip_transactions.count_documents({'user_id':uid})==0
  assert await db.rummy_seats.count_documents({'user_id':uid})==0
  REPORT['public_checks']={'categories_http':200,'all_five_rates_bps':BPS,'missing_acknowledgement_http':409,'zero_balance_guard_http':409,'funded_bets_placed':0}
 finally:
  await db.users.update_one({'id':uid},{'$set':{'status':'SUSPENDED','qa_test':True},'$unset':{'active_session_id':''}})
  REPORT['qa_account_disabled']=True
 REPORT['financial_ready']=health['financial_ready']
 REPORT['frontend_release']='20261120-rummy-commission'
 REPORT['code_hashes_verified']=True
 Path('/data/chakri/rummy-commission-rollout.json').write_text(json.dumps(REPORT,indent=2))
 print(json.dumps(REPORT),flush=True)
asyncio.run(main())
