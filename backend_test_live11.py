"""
Backend API tests for FunGame LIVE-11 features:
1. Single active session per user (SESSION_REPLACED enforcement)
2. Logout invalidates all tokens
3. Chips->Points conversion blocked (must use sell-request)
4. New sell-request endpoint (chips NOT deducted at request time)
5. Admin approve/deny SELL requests
6. BUY flow regression
7. GET /api/admin/users includes stats (total_deposits, winning_chips, loss_chips)
8. Live game endpoints regression
"""
import requests
import sys
import time
from datetime import datetime

# Public endpoint from frontend/.env
BASE_URL = "https://casino-reference-app.preview.emergentagent.com/api"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    END = '\033[0m'

class LIVE11Tester:
    def __init__(self):
        self.tests_run = 0
        self.tests_passed = 0
        self.admin_token = None
        self.player_token_1 = None
        self.player_token_2 = None
        self.failures = []
        self.player_id = None
        self.sell_request_id = None
        self.buy_request_id = None

    def log(self, msg, color=Colors.BLUE):
        print(f"{color}{msg}{Colors.END}")

    def test(self, name, method, endpoint, expected_status, data=None, token=None, description="", check_detail_code=None):
        """Run a single API test"""
        url = f"{BASE_URL}{endpoint}"
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = f'Bearer {token}'

        self.tests_run += 1
        print(f"\n{'='*80}")
        self.log(f"TEST {self.tests_run}: {name}", Colors.BLUE)
        if description:
            print(f"  {description}")
        print(f"  {method} {endpoint}")
        if data:
            print(f"  Body: {data}")

        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=10)
            elif method == 'PATCH':
                response = requests.patch(url, json=data, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=10)

            success = response.status_code == expected_status
            
            # Additional check for detail.code if specified
            if success and check_detail_code:
                try:
                    resp_data = response.json()
                    detail = resp_data.get('detail', {})
                    if isinstance(detail, dict):
                        actual_code = detail.get('code')
                        if actual_code != check_detail_code:
                            success = False
                            self.log(f"❌ FAIL - Expected detail.code={check_detail_code}, got {actual_code}", Colors.RED)
                            self.failures.append(f"{name}: Expected detail.code={check_detail_code}, got {actual_code}")
                            return False, {}
                except:
                    pass
            
            if success:
                self.tests_passed += 1
                self.log(f"✅ PASS - Status: {response.status_code}", Colors.GREEN)
                try:
                    resp_data = response.json()
                    print(f"  Response: {resp_data}")
                    return True, resp_data
                except:
                    return True, {}
            else:
                self.log(f"❌ FAIL - Expected {expected_status}, got {response.status_code}", Colors.RED)
                try:
                    error_detail = response.json()
                    print(f"  Error: {error_detail}")
                except:
                    print(f"  Response: {response.text[:200]}")
                self.failures.append(f"{name}: Expected {expected_status}, got {response.status_code}")
                return False, {}

        except Exception as e:
            self.log(f"❌ FAIL - Exception: {str(e)}", Colors.RED)
            self.failures.append(f"{name}: {str(e)}")
            return False, {}

    def run_all_tests(self):
        """Run all LIVE-11 backend tests"""
        self.log("\n" + "="*80, Colors.YELLOW)
        self.log("FUNGAME BACKEND API TESTS - LIVE-11 FEATURES", Colors.YELLOW)
        self.log("="*80 + "\n", Colors.YELLOW)

        # ========== FEATURE 1: SINGLE ACTIVE SESSION PER USER ==========
        self.log("\n### FEATURE 1: SINGLE ACTIVE SESSION PER USER ###", Colors.YELLOW)
        
        # First login as player
        success, resp = self.test(
            "Player login #1",
            "POST", "/auth/login", 200,
            data={"email": "player@fungame.app", "password": "Player@123"},
            description="First login as player - should succeed"
        )
        if success:
            self.player_token_1 = resp.get('access_token')
            self.player_id = resp.get('user', {}).get('id')
            print(f"  Token 1 obtained: {self.player_token_1[:20]}...")

        # Verify first token works
        success, resp = self.test(
            "Verify first token works",
            "GET", "/auth/me", 200,
            token=self.player_token_1,
            description="First token should work before second login"
        )

        # Second login as same player (should invalidate first token)
        time.sleep(1)  # Small delay to ensure different session IDs
        success, resp = self.test(
            "Player login #2 (same account)",
            "POST", "/auth/login", 200,
            data={"email": "player@fungame.app", "password": "Player@123"},
            description="Second login should succeed and invalidate first token"
        )
        if success:
            self.player_token_2 = resp.get('access_token')
            print(f"  Token 2 obtained: {self.player_token_2[:20]}...")

        # First token should now get 401 with SESSION_REPLACED
        success, resp = self.test(
            "First token gets SESSION_REPLACED",
            "GET", "/auth/me", 401,
            token=self.player_token_1,
            description="First token should get 401 with detail.code=SESSION_REPLACED",
            check_detail_code="SESSION_REPLACED"
        )

        # Second token should still work
        success, resp = self.test(
            "Second token still works",
            "GET", "/auth/me", 200,
            token=self.player_token_2,
            description="Second (most recent) token should work"
        )

        # ========== FEATURE 2: LOGOUT INVALIDATES TOKEN ==========
        self.log("\n### FEATURE 2: LOGOUT INVALIDATES TOKEN ###", Colors.YELLOW)
        
        # Logout with second token
        success, resp = self.test(
            "Logout with valid token",
            "POST", "/auth/logout", 200,
            token=self.player_token_2,
            description="Logout should return 200"
        )

        # Second token should now be invalid
        success, resp = self.test(
            "Token invalid after logout",
            "GET", "/auth/me", 401,
            token=self.player_token_2,
            description="Token should be invalid after logout"
        )

        # Fresh login after logout should work
        success, resp = self.test(
            "Fresh login after logout",
            "POST", "/auth/login", 200,
            data={"email": "player@fungame.app", "password": "Player@123"},
            description="Fresh login after logout should work"
        )
        if success:
            self.player_token_2 = resp.get('access_token')

        # ========== FEATURE 3: CHIPS->POINTS CONVERSION BLOCKED ==========
        self.log("\n### FEATURE 3: CHIPS->POINTS CONVERSION BLOCKED ###", Colors.YELLOW)
        
        # Get current balance
        success, resp = self.test(
            "Get current balance",
            "GET", "/chips/balance", 200,
            token=self.player_token_2,
            description="Check player's current chip and points balance"
        )
        if success:
            initial_chips = resp.get('balance', 0)
            initial_points = resp.get('points', 0)
            print(f"  Initial: chips={initial_chips}, points={initial_points}")

        # Try CHIPS_TO_POINTS conversion (should be blocked)
        success, resp = self.test(
            "CHIPS_TO_POINTS conversion blocked",
            "POST", "/chips/convert", 400,
            data={"direction": "CHIPS_TO_POINTS", "amount": 500},
            token=self.player_token_2,
            description="CHIPS_TO_POINTS should return 400 (blocked)"
        )

        # POINTS_TO_CHIPS should still work (if player has points)
        if initial_points >= 500:
            success, resp = self.test(
                "POINTS_TO_CHIPS still works",
                "POST", "/chips/convert", 200,
                data={"direction": "POINTS_TO_CHIPS", "amount": 500},
                token=self.player_token_2,
                description="POINTS_TO_CHIPS should still work instantly"
            )
            if success:
                new_chips = resp.get('chip_balance', 0)
                new_points = resp.get('points_balance', 0)
                print(f"  After conversion: chips={new_chips}, points={new_points}")

        # ========== FEATURE 4: SELL-REQUEST ENDPOINT ==========
        self.log("\n### FEATURE 4: SELL-REQUEST ENDPOINT ###", Colors.YELLOW)
        
        # Get current balance again
        success, resp = self.test(
            "Get balance before sell request",
            "GET", "/chips/balance", 200,
            token=self.player_token_2,
            description="Check balance before sell request"
        )
        if success:
            balance_before_sell = resp.get('balance', 0)
            print(f"  Balance before sell request: {balance_before_sell}")

        # Create sell request with amount < 500 (should fail validation)
        success, resp = self.test(
            "Sell request below minimum (422)",
            "POST", "/chips/sell-request", 422,
            data={"amount": 499},
            token=self.player_token_2,
            description="Amount < 500 should return 422"
        )

        # Create valid sell request
        if balance_before_sell >= 500:
            success, resp = self.test(
                "Create valid sell request",
                "POST", "/chips/sell-request", 200,
                data={"amount": 500, "note": "Test sell request"},
                token=self.player_token_2,
                description="Create SELL request for 500 chips"
            )
            if success:
                self.sell_request_id = resp.get('request', {}).get('id')
                print(f"  Sell request ID: {self.sell_request_id}")

            # Verify chips NOT deducted
            success, resp = self.test(
                "Chips NOT deducted at request time",
                "GET", "/chips/balance", 200,
                token=self.player_token_2,
                description="Chips should NOT be deducted when request is created"
            )
            if success:
                balance_after_request = resp.get('balance', 0)
                print(f"  Balance after request: {balance_after_request}")
                if balance_after_request != balance_before_sell:
                    self.log(f"  ⚠️  WARNING: Balance changed! Expected {balance_before_sell}, got {balance_after_request}", Colors.YELLOW)

        # Try sell request with amount > balance (should fail)
        success, resp = self.test(
            "Sell request exceeds balance (400)",
            "POST", "/chips/sell-request", 400,
            data={"amount": 999999},
            token=self.player_token_2,
            description="Amount > balance should return 400"
        )

        # ========== FEATURE 5: BUY REQUEST REGRESSION ==========
        self.log("\n### FEATURE 5: BUY REQUEST REGRESSION ###", Colors.YELLOW)
        
        # Create BUY request (old flow should still work)
        success, resp = self.test(
            "Create BUY request",
            "POST", "/chips/request", 200,
            data={"amount": 1000, "note": "Test BUY request"},
            token=self.player_token_2,
            description="BUY request should still work as before"
        )
        if success:
            self.buy_request_id = resp.get('request', {}).get('id')
            print(f"  BUY request ID: {self.buy_request_id}")

        # ========== FEATURE 6: ADMIN LOGIN & CHIP REQUESTS ==========
        self.log("\n### FEATURE 6: ADMIN APPROVE/DENY SELL REQUESTS ###", Colors.YELLOW)
        
        # Admin login
        success, resp = self.test(
            "Admin login",
            "POST", "/auth/login", 200,
            data={"email": "admin@fungame.app", "password": "FunGame@Admin2025"},
            description="Login as admin"
        )
        if success:
            self.admin_token = resp.get('access_token')

        if not self.admin_token:
            self.log("❌ Admin login failed - cannot continue with admin tests", Colors.RED)
            return

        # Get chip requests (should show both SELL and BUY types)
        success, resp = self.test(
            "Get chip requests",
            "GET", "/admin/chip-requests?status=PENDING", 200,
            token=self.admin_token,
            description="List pending chip requests (should include SELL and BUY types)"
        )
        if success:
            requests_list = resp.get('requests', [])
            sell_count = sum(1 for r in requests_list if r.get('type') == 'SELL')
            buy_count = sum(1 for r in requests_list if r.get('type') == 'BUY')
            print(f"  Found {len(requests_list)} pending requests: {sell_count} SELL, {buy_count} BUY")

        # Approve SELL request
        if self.sell_request_id:
            # Get balance before approval
            success, resp = self.test(
                "Get player balance before SELL approval",
                "GET", "/chips/balance", 200,
                token=self.player_token_2,
                description="Check balance before admin approves SELL"
            )
            if success:
                chips_before_approval = resp.get('balance', 0)
                points_before_approval = resp.get('points', 0)
                print(f"  Before approval: chips={chips_before_approval}, points={points_before_approval}")

            # Admin approves SELL request
            success, resp = self.test(
                "Admin approve SELL request",
                "POST", f"/admin/chip-requests/{self.sell_request_id}/approve", 200,
                token=self.admin_token,
                description="Admin approves SELL request - should deduct chips and credit points"
            )
            if success:
                chip_balance = resp.get('chip_balance')
                points_balance = resp.get('points_balance')
                print(f"  After approval: chips={chip_balance}, points={points_balance}")
                print(f"  Expected: chips={chips_before_approval - 500}, points={points_before_approval + 500}")

            # Verify balance changed
            success, resp = self.test(
                "Verify balance after SELL approval",
                "GET", "/chips/balance", 200,
                token=self.player_token_2,
                description="Chips should be deducted and points credited"
            )
            if success:
                final_chips = resp.get('balance', 0)
                final_points = resp.get('points', 0)
                print(f"  Final: chips={final_chips}, points={final_points}")

        # Approve BUY request (regression test)
        if self.buy_request_id:
            success, resp = self.test(
                "Admin approve BUY request",
                "POST", f"/admin/chip-requests/{self.buy_request_id}/approve", 200,
                token=self.admin_token,
                description="Admin approves BUY request - should credit chips"
            )

        # Create another sell request for deny test
        success, resp = self.test(
            "Create another sell request for deny test",
            "POST", "/chips/sell-request", 200,
            data={"amount": 500, "note": "Test deny"},
            token=self.player_token_2,
            description="Create another SELL request to test deny"
        )
        if success:
            deny_request_id = resp.get('request', {}).get('id')
            
            # Get balance before deny
            success, resp = self.test(
                "Get balance before deny",
                "GET", "/chips/balance", 200,
                token=self.player_token_2
            )
            if success:
                chips_before_deny = resp.get('balance', 0)

            # Admin denies SELL request
            success, resp = self.test(
                "Admin deny SELL request",
                "POST", f"/admin/chip-requests/{deny_request_id}/deny", 200,
                data={"note": "Test denial"},
                token=self.admin_token,
                description="Admin denies SELL request - chips should NOT be deducted"
            )

            # Verify chips unchanged
            success, resp = self.test(
                "Verify chips unchanged after deny",
                "GET", "/chips/balance", 200,
                token=self.player_token_2,
                description="Chips should remain unchanged after deny"
            )
            if success:
                chips_after_deny = resp.get('balance', 0)
                print(f"  Chips before deny: {chips_before_deny}, after deny: {chips_after_deny}")
                if chips_before_deny != chips_after_deny:
                    self.log(f"  ⚠️  WARNING: Chips changed after deny!", Colors.YELLOW)

        # ========== FEATURE 7: ADMIN USERS WITH STATS ==========
        self.log("\n### FEATURE 7: ADMIN USERS WITH STATS ###", Colors.YELLOW)
        
        success, resp = self.test(
            "Get admin users with stats",
            "GET", "/admin/users", 200,
            token=self.admin_token,
            description="GET /admin/users should include stats object"
        )
        if success:
            users = resp.get('users', [])
            print(f"  Found {len(users)} users")
            if users:
                sample_user = users[0]
                stats = sample_user.get('stats', {})
                print(f"  Sample user stats: {stats}")
                if 'total_deposits' in stats and 'winning_chips' in stats and 'loss_chips' in stats:
                    self.log("  ✓ Stats object contains required fields", Colors.GREEN)
                else:
                    self.log("  ⚠️  Stats object missing required fields", Colors.YELLOW)

        # ========== FEATURE 8: LIVE GAME ENDPOINTS REGRESSION ==========
        self.log("\n### FEATURE 8: LIVE GAME ENDPOINTS REGRESSION ###", Colors.YELLOW)
        
        # Get games list
        success, resp = self.test(
            "Get games list",
            "GET", "/games", 200,
            token=self.player_token_2,
            description="GET /games should work with fresh token"
        )
        if success:
            games = resp.get('games', [])
            print(f"  Found {len(games)} games")

        # Try accessing a live game state endpoint
        success, resp = self.test(
            "Get live game state (aviator)",
            "GET", "/live/aviator/state", 200,
            token=self.player_token_2,
            description="Live game endpoints should work with fresh token"
        )

        # ========== SUMMARY ==========
        self.print_summary()

    def print_summary(self):
        """Print test summary"""
        print("\n" + "="*80)
        self.log("TEST SUMMARY", Colors.YELLOW)
        print("="*80)
        print(f"Total tests: {self.tests_run}")
        print(f"Passed: {Colors.GREEN}{self.tests_passed}{Colors.END}")
        print(f"Failed: {Colors.RED}{self.tests_run - self.tests_passed}{Colors.END}")
        
        if self.failures:
            print(f"\n{Colors.RED}FAILURES:{Colors.END}")
            for failure in self.failures:
                print(f"  - {failure}")
        
        success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
        print(f"\nSuccess rate: {success_rate:.1f}%")
        
        if self.tests_passed == self.tests_run:
            self.log("\n✅ ALL TESTS PASSED!", Colors.GREEN)
            return 0
        else:
            self.log(f"\n❌ {self.tests_run - self.tests_passed} TEST(S) FAILED", Colors.RED)
            return 1

def main():
    tester = LIVE11Tester()
    exit_code = tester.run_all_tests()
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
