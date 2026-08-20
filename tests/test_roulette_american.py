"""Exhaustive check of the American roulette engine."""
import os, sys, math, itertools
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from fastapi import HTTPException
from game_engines import (AMERICAN_ORDER, ROULETTE_POCKETS, ROULETTE_SECTORS,
                          ROULETTE_RED, roulette_color, roulette_multiplier,
                          roulette_payout, LEGAL_INSIDE)
from live_engines import ROULETTE_TIMING, betting_mutation_open, fixed_cycle_clock, roulette_history_max_round

fail = []
def ck(cond, msg):
    if not cond: fail.append(msg)

# ---- the live broadcast clock ----
ck(ROULETTE_TIMING == {"bet": 30, "spin": 20, "result": 10},
   "roulette must run a 60s cycle with betting locked after 30s")
ck(sum(ROULETTE_TIMING.values()) == 60, "roulette round must total exactly 60s")
ck(roulette_history_max_round(800, "BETTING") == 799,
   "current roulette round must stay out of history while betting")
ck(roulette_history_max_round(800, "SPINNING") == 799,
   "current roulette winner must stay out of history while spinning")
ck(roulette_history_max_round(800, "RESULT") == 800,
   "current roulette round should enter history only during result")
ck(betting_mutation_open("BETTING", .41, 800, expected_round=800),
   "roulette mutation guard should remain open above 0.4s")
ck(not betting_mutation_open("BETTING", .40, 800, expected_round=800),
   "roulette mutation guard must close at the 0.4s boundary")

def roulette_clock(now):
    return fixed_cycle_clock(now, 30, 20, 10, "SPINNING")

for timestamp, expected in [
    (29.99, (0, "BETTING", 0.01)),
    (30.00, (0, "SPINNING", 20.0)),
    (49.99, (0, "SPINNING", 0.01)),
    (50.00, (0, "RESULT", 10.0)),
    (59.99, (0, "RESULT", 0.01)),
    (60.00, (1, "BETTING", 30.0)),
]:
    ck(roulette_clock(timestamp)[:3] == expected,
       f"roulette clock boundary {timestamp:.2f} must be {expected}")

# ---- the wheel itself ----
ck(len(AMERICAN_ORDER) == 38, "wheel must have 38 pockets")
ck(len(set(AMERICAN_ORDER)) == 38, "pockets must be unique")
ck(sorted(int(x) for x in AMERICAN_ORDER if x not in ("0","00")) == list(range(1,37)), "must cover 1-36")
i0, i00 = AMERICAN_ORDER.index("0"), AMERICAN_ORDER.index("00")
ck(abs(i0 - i00) == 19, "0 and 00 must be opposite")
ck(sum(1 for p in AMERICAN_ORDER if roulette_color(p)=="red") == 18, "18 reds")
ck(sum(1 for p in AMERICAN_ORDER if roulette_color(p)=="black") == 18, "18 blacks")
ck(sum(1 for p in AMERICAN_ORDER if roulette_color(p)=="green") == 2, "2 greens")
ck(roulette_color(0)=="green" and roulette_color("00")=="green" and roulette_color(17)=="black",
   "colour of 0 / 00 / 17")

# ---- every bet returns exactly 36/38 per unit: a uniform 5.26% edge ----
def rtp(btype, value):
    tot = sum(roulette_multiplier(btype, value, w) for w in ROULETTE_POCKETS)
    return tot / len(ROULETTE_POCKETS)

bets = [("straight", p) for p in ROULETTE_POCKETS]
bets += [("color","red"),("color","black"),("parity","odd"),("parity","even"),
         ("range","low"),("range","high")]
bets += [("dozen",d) for d in (1,2,3)] + [("column",c) for c in (1,2,3)]
for btype,(allowed,size) in LEGAL_INSIDE.items():
    for combo in allowed:
        bets.append((btype, "-".join(sorted(combo, key=lambda x:(len(x),x)))))
bets += [("sector",s) for s in ROULETTE_SECTORS]
for btype, value in bets:
    r = rtp(btype, value)
    ck(abs(r - 36/38) < 1e-9, f"RTP wrong for {btype}:{value} -> {r:.6f}")

# ---- the zeros must kill every outside bet ----
for z in ("0","00"):
    for btype,value in [("color","red"),("color","black"),("parity","odd"),("parity","even"),
                        ("range","low"),("range","high"),("dozen",1),("dozen",2),("dozen",3),
                        ("column",1),("column",2),("column",3)]:
        ck(roulette_multiplier(btype,value,z)==0, f"{btype}:{value} must lose on {z}")

# ---- 0 and 00 must be DISTINCT pockets ----
ck(roulette_multiplier("straight","00","0")==0, "a 00 bet must not win on 0")
ck(roulette_multiplier("straight",0,"00")==0, "a 0 bet must not win on 00")
ck(roulette_multiplier("straight","00","00")==36, "a 00 bet must win on 00")
ck(roulette_multiplier("basket","0-00-1-2-3","00")==36/5, "basket pays on 00")

# ---- illegal shapes must be REJECTED, not silently paid ----
illegal = [
    ("sixline","17"),                  # one number claiming a six-line payout
    ("sixline","1-2-3-4-5-7"),         # six numbers, not a real six line
    ("street","1-2-4"),                # not a row
    ("split","1-5"),                   # not adjacent
    ("split","17-17"),                 # duplicate
    ("corner","1-2-3-4"),              # not a square on an American layout
    ("basket","0-1-2-3-4"),            # not the first five
    ("sector","everything"),           # unknown arc
    ("sector","0-1-2"),                # arcs are named, not listed
    ("straight","000"),
    ("straight",37),
    ("straight",-1),
    ("nonsense","x"),
]
for btype, value in illegal:
    try:
        roulette_multiplier(btype, value, "17")
        fail.append(f"ACCEPTED an illegal bet: {btype}:{value}")
    except HTTPException:
        pass

# ---- payout rounding must match JavaScript's Math.round ----
js_round = lambda x: math.floor(x + 0.5)
for amount in range(1, 4000):
    for _, size in [(None,5),(None,19),(None,6),(None,3)]:
        m = 36/size
        ck(roulette_payout(amount, m) == js_round(amount*m),
           f"rounding differs for {amount} x 36/{size}")
        if fail: break
    if fail: break

print(f"bets checked: {len(bets)}   pockets: {len(ROULETTE_POCKETS)}")
print(f"legal inside bets: " + ", ".join(f"{k}={len(v[0])}" for k,v in LEGAL_INSIDE.items()))
print("edge:", f"{(1-36/38)*100:.2f}%")
if fail:
    print(f"\n{len(fail)} FAILURES:"); [print("  -", f) for f in fail[:20]]; sys.exit(1)
print("\nall checks passed")
