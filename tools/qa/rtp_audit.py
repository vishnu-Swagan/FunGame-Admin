"""Offline eight-strategy RTP experiment; never connects to a database."""
import os,json,math,secrets,time
from fractions import Fraction
from math import comb
os.environ.setdefault('AVIATOR_RETURN_FACTOR','0.945')
import game_engines as g,live_engines as l,chicken_road_engine as cr,blackjack as bj
N=int(os.environ.get('QA_ROUNDS','20000'));STAKE=100
report={'rounds_per_strategy':N,'players':8,'stake':STAKE,'aviator_factor':float(os.environ['AVIATOR_RETURN_FACTOR']),'games':{},'exact':{}}
def stats(values,n):
 total,sq=values;mean=total/n;var=max(0,(sq-total*total/n)/(n-1));se=math.sqrt(var/n)
 return {'rtp_percent':round(mean*100,4),'ci95_percent':[round((mean-1.96*se)*100,4),round((mean+1.96*se)*100,4)],'bets':n}
def experiment(name,profiles,outcome,payout):
 sums=[[0.,0.] for _ in profiles]
 for _ in range(N):
  o=outcome()
  for i,p in enumerate(profiles):
   x=payout(o,p)/STAKE
   assert math.isfinite(x) and x>=0
   sums[i][0]+=x;sums[i][1]+=x*x
 report['games'][name]=[{'profile':p,**stats(s,N)} for p,s in zip(profiles,sums)]
 print(name,'complete',flush=True)
experiment('seven-up-down',['up','down','seven','t2','t3','t4','t5','t6'],lambda:l.generate_outcome('seven-up-down'),lambda o,p:l.settle_bet('seven-up-down',o,p,STAKE)[0])
experiment('andar-bahar',['andar','bahar','count_1_5','count_6_10','count_11_15','count_16_25','count_26_30','count_41_49'],lambda:l.generate_outcome('andar-bahar'),lambda o,p:l.settle_bet('andar-bahar',o,p,STAKE)[0])
experiment('keno',[1,2,3,4,5,6,9,10],lambda:l.generate_outcome('keno'),lambda o,p:l.settle_bet('keno',o,list(range(1,p+1)),STAKE)[0])
experiment('pappu-pictures',list(l.PICTURE_SYMBOLS[:8]),lambda:l.generate_outcome('pappu-pictures'),lambda o,p:l.settle_bet('pappu-pictures',o,p,STAKE)[0])
for slug in ['teen-patti','poker']:
 experiment(slug,['player','dealer','tie','player','dealer','tie','player','dealer'],lambda s=slug:l.generate_outcome(s),lambda o,p,s=slug:l.settle_bet(s,o,p,STAKE)[0])
experiment('aviator',[1.1,1.25,1.5,2.,3.,5.,10.,20.],lambda:g.aviator_crash_point(),lambda o,p:g.aviator_payout_chips(STAKE,p) if o>=p else 0)
profiles=[('color','red'),('color','black'),('parity','even'),('parity','odd'),('straight','1'),('straight','0'),('straight','00'),('dozen','1')]
# Validate labels against the same implementation before the Monte Carlo run.
valid=[]
for p in profiles:
 try:g.roulette_multiplier(p[0],p[1],'1');valid.append(p)
 except Exception:pass
while len(valid)<8:valid.append(('color','red'))
experiment('fun-roulette',valid,lambda:g.RNG.choice(g.ROULETTE_POCKETS),lambda o,p:g.roulette_payout(STAKE,g.roulette_multiplier(p[0],p[1],o)))
# Independent shoes per strategy; simple hit-to-threshold policies, NOT optimal basic strategy.
sums=[[0.,0.] for _ in range(8)]
for _ in range(N):
 for i in range(8):
  shoe=bj.new_shoe();player=[shoe.pop(),shoe.pop()];dealer=[shoe.pop(),shoe.pop()]
  if not bj.is_blackjack(player) and not bj.is_blackjack(dealer):
   while bj.hand_value(player)<12+i:player.append(shoe.pop())
  while bj.dealer_should_hit(dealer):dealer.append(shoe.pop())
  payout,_=bj.settle_hand(player,dealer,STAKE);x=payout/STAKE;sums[i][0]+=x;sums[i][1]+=x*x
report['games']['blackjack']=[{'profile':'hit below '+str(12+i)+'; no split/double/insurance',**stats(s,N)} for i,s in enumerate(sums)]
print('blackjack complete',flush=True)
profiles=[('easy',1),('easy',5),('medium',1),('medium',5),('hard',1),('hard',5),('hardcore',1),('hardcore',5)]
experiment('chicken-road',profiles,lambda:secrets.token_hex(32),lambda seed,p:cr.payout_chips(STAKE,p[0],p[1]) if all(cr.lane_survives(seed,'0'*64,'offline-qa',p[0],lane) for lane in range(1,p[1]+1)) else 0)
report['games']['rummy']={'rtp':'Not estimated: multiplayer skill and settlement rules require a separate full-hand study; practice rounds do not measure paid RTP.'}
report['exact']['keno']={str(n):100*sum(comb(n,h)*comb(36-n,10-h)/comb(36,10)*round(STAKE*mult)/STAKE for h,mult in table.items()) for n,table in g.KENO_PAYTABLE.items()}
report['exact']['roulette_standard_bets']=36/38*100
report['exact']['seven_up_down']={k:100*sum(1 for a in range(1,7) for b in range(1,7) if ('seven' if a+b==7 else 'up' if a+b>7 else 'down')==k)/36*v for k,v in l.SIDE_OPTIONS['seven-up-down'].items() if k in ['up','down','seven']}
boost=sum(v*w for v,w in l.PICTURE_EXTRA_MULTIPLIERS)/sum(w for v,w in l.PICTURE_EXTRA_MULTIPLIERS)
report['exact']['pappu_pictures']=100*(l.PICTURE_BASE_MULTIPLIER+.35*5/12*(boost-l.PICTURE_BASE_MULTIPLIER))/12
report['exact']['chicken_road']=cr.rules_payload()['rtp_bps']/100
with open('/data/chakri/eight-player-rtp.json','w') as f:json.dump(report,f,indent=2)
print(json.dumps({'games':len(report['games']),'strategy_bets':sum(sum(x['bets'] for x in v) for v in report['games'].values() if isinstance(v,list)),'exact':report['exact']}),flush=True)
