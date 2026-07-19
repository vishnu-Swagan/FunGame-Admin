"""FunGame POC core-flow test (Phase 1).

Covers: register -> verify email (demo code) -> onboarding profile -> submit ->
PENDING gating (blocked from games) -> admin approve (welcome bonus) ->
lobby (18 games, none playable) -> chip request -> admin approve ->
balance + ledger + notifications -> maintenance gating -> no payment routes.
"""
import requests
import uuid
import sys

BASE = "http://localhost:8001/api"
PASSED, FAILED = [], []


def check(name, cond, extra=""):
    if cond:
        PASSED.append(name)
        print(f"  PASS: {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL: {name} {extra}")


def main():
    email = f"poc_{uuid.uuid4().hex[:8]}@test.com"
    password = "Test@12345"

    print("\n== 1. Register ==")
    r = requests.post(f"{BASE}/auth/register", json={"email": email, "password": password})
    check("register 200", r.status_code == 200, r.text)
    dev_code = r.json().get("dev_code")
    check("dev_code returned (demo mode)", bool(dev_code))

    print("\n== 2. Login blocked before verification ==")
    r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    check("unverified login blocked 403", r.status_code == 403, r.text)

    print("\n== 3. Verify email ==")
    r = requests.post(f"{BASE}/auth/verify-email", json={"email": email, "code": dev_code})
    check("verify 200", r.status_code == 200, r.text)
    token = r.json().get("access_token")
    check("token issued on verify", bool(token))
    H = {"Authorization": f"Bearer {token}"}

    print("\n== 4. Onboarding ==")
    r = requests.post(f"{BASE}/onboarding/profile", headers=H, json={
        "display_name": "POC Tester", "country": "India", "avatar": "star", "accepted_terms": True})
    check("profile saved", r.status_code == 200, r.text)
    r = requests.post(f"{BASE}/onboarding/submit", headers=H)
    check("submitted -> PENDING", r.status_code == 200 and r.json()["user"]["status"] == "PENDING", r.text)

    print("\n== 5. PENDING user blocked from app areas ==")
    r = requests.get(f"{BASE}/games", headers=H)
    check("games blocked for PENDING (403)", r.status_code == 403, r.text)
    r = requests.get(f"{BASE}/chips/balance", headers=H)
    check("chips blocked for PENDING (403)", r.status_code == 403, r.text)

    print("\n== 6. Admin login + approve ==")
    r = requests.post(f"{BASE}/auth/login", json={"email": "admin@fungame.app", "password": "FunGame@Admin2025"})
    check("admin login", r.status_code == 200, r.text)
    atoken = r.json()["access_token"]
    AH = {"Authorization": f"Bearer {atoken}"}
    r = requests.get(f"{BASE}/admin/users?status=PENDING", headers=AH)
    pending = [u for u in r.json()["users"] if u["email"] == email]
    check("pending user visible to admin", len(pending) == 1)
    uid = pending[0]["id"]
    r = requests.post(f"{BASE}/admin/users/{uid}/approve", headers=AH, json={})
    check("approve 200 + ACTIVE", r.status_code == 200 and r.json()["user"]["status"] == "ACTIVE", r.text)

    print("\n== 7. Approved user: lobby with 18 games, none playable ==")
    r = requests.get(f"{BASE}/games", headers=H)
    games = r.json().get("games", [])
    check("games list 200", r.status_code == 200)
    check("exactly 18 games", len(games) == 18, f"got {len(games)}")
    check("all COMING_SOON", all(g["status"] == "COMING_SOON" for g in games))
    r = requests.post(f"{BASE}/games/aviator/play", headers=H)
    check("play blocked (409)", r.status_code == 409, r.text)

    print("\n== 8. Welcome bonus credited ==")
    r = requests.get(f"{BASE}/chips/balance", headers=H)
    check("welcome bonus 1000", r.json().get("balance") == 1000, r.text)

    print("\n== 9. Chip request lifecycle ==")
    r = requests.post(f"{BASE}/chips/request", headers=H, json={"amount": 2500, "note": "POC request"})
    check("chip request created", r.status_code == 200, r.text)
    req_id = r.json()["request"]["id"]
    r = requests.post(f"{BASE}/admin/chip-requests/{req_id}/approve", headers=AH, json={})
    check("admin approves request", r.status_code == 200, r.text)
    r = requests.post(f"{BASE}/admin/chip-requests/{req_id}/approve", headers=AH, json={})
    check("double-approve blocked (idempotent)", r.status_code == 400, r.text)
    r = requests.get(f"{BASE}/chips/balance", headers=H)
    check("balance 3500 after approval", r.json().get("balance") == 3500, r.text)
    r = requests.get(f"{BASE}/chips/transactions", headers=H)
    txs = r.json()["transactions"]
    check("ledger has 2 credits", len(txs) == 2 and all(t["type"] == "CREDIT" for t in txs))

    print("\n== 10. Notifications ==")
    r = requests.get(f"{BASE}/notifications", headers=H)
    notifs = r.json()["notifications"]
    titles = [n["title"] for n in notifs]
    check("approval notification", any("approved" in t.lower() for t in titles), titles)
    check("chips notification", any("chips" in t.lower() for t in titles), titles)

    print("\n== 11. Favorites + recent ==")
    r = requests.post(f"{BASE}/games/aviator/favorite", headers=H)
    check("favorite toggled", r.status_code == 200 and "aviator" in r.json()["favorites"])
    r = requests.get(f"{BASE}/games/teen-patti", headers=H)
    check("game detail 200", r.status_code == 200)
    r = requests.get(f"{BASE}/games", headers=H)
    check("recent tracked", "teen-patti" in r.json().get("recent", []))

    print("\n== 12. Maintenance gating ==")
    r = requests.patch(f"{BASE}/admin/system", headers=AH, json={"maintenance_mode": True})
    check("maintenance ON", r.status_code == 200)
    r = requests.get(f"{BASE}/games", headers=H)
    check("player blocked in maintenance (503)", r.status_code == 503, r.text)
    r = requests.get(f"{BASE}/admin/stats", headers=AH)
    check("admin still works in maintenance", r.status_code == 200)
    r = requests.patch(f"{BASE}/admin/system", headers=AH, json={"maintenance_mode": False})
    check("maintenance OFF", r.status_code == 200)

    print("\n== 13. No payment/cash-out routes exist ==")
    for path in ["/payments", "/deposit", "/withdraw", "/cashout", "/chips/buy", "/chips/transfer"]:
        r = requests.post(f"{BASE}{path}", headers=H, json={})
        check(f"no route {path}", r.status_code in (404, 405))

    print(f"\n{'='*50}\nRESULT: {len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        print("FAILED:", FAILED)
        sys.exit(1)
    print("POC CORE FLOW: ALL GREEN")


if __name__ == "__main__":
    main()
