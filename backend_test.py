"""
Backend API tests for FunGame Points Economy + Admin-Provisioned Accounts features.
Tests both new features:
1. Points economy (chips <-> points conversion, admin adjustments)
2. Admin-provisioned accounts (signup requests, admin approval with username/password)
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

class APITester:
    def __init__(self):
        self.tests_run = 0
        self.tests_passed = 0
        self.admin_token = None
        self.player_token = None
        self.test_user_id = None
        self.test_signup_request_id = None
        self.test_username = None
        self.test_password = None
        self.failures = []

    def log(self, msg, color=Colors.BLUE):
        print(f"{color}{msg}{Colors.END}")

    def test(self, name, method, endpoint, expected_status, data=None, token=None, description=""):
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
        """Run all backend tests"""
        self.log("\n" + "="*80, Colors.YELLOW)
        self.log("FUNGAME BACKEND API TESTS - Points Economy + Admin-Provisioned Accounts", Colors.YELLOW)
        self.log("="*80 + "\n", Colors.YELLOW)

        # ========== FEATURE 1: CLOSED PUBLIC REGISTRATION ==========
        self.log("\n### FEATURE 1: PUBLIC REGISTRATION CLOSED ###", Colors.YELLOW)
        
        success, _ = self.test(
            "Register endpoint returns 410",
            "POST", "/auth/register", 410,
            data={"email": "test@example.com", "password": "TestPass123!"},
            description="Public signup is closed - should return 410"
        )

        # ========== FEATURE 2: SIGNUP REQUEST FLOW ==========
        self.log("\n### FEATURE 2: SIGNUP REQUEST FLOW ###", Colors.YELLOW)
        
        # Valid signup request
        success, resp = self.test(
            "Create signup request - valid",
            "POST", "/auth/signup-request", 200,
            data={
                "full_name": "QA Tester",
                "email": "qa.signup@example.com",
                "date_of_birth": "1994-05-20",
                "phone": "+14155552671"
            },
            description="Submit valid signup request"
        )
        if success:
            self.test_signup_request_id = resp.get('request_id')

        # Duplicate pending request
        self.test(
            "Duplicate pending signup request - 409",
            "POST", "/auth/signup-request", 409,
            data={
                "full_name": "QA Tester",
                "email": "qa.signup@example.com",
                "date_of_birth": "1994-05-20",
                "phone": "+14155552671"
            },
            description="Same email with pending request should return 409"
        )

        # Invalid phone (no country code)
        self.test(
            "Invalid phone without country code - 422",
            "POST", "/auth/signup-request", 422,
            data={
                "full_name": "Invalid Phone",
                "email": "invalid.phone@example.com",
                "date_of_birth": "1994-05-20",
                "phone": "1234567890"
            },
            description="Phone without country code should return 422"
        )

        # Existing user email
        self.test(
            "Signup request with existing user email - 409",
            "POST", "/auth/signup-request", 409,
            data={
                "full_name": "Existing User",
                "email": "player@fungame.app",
                "date_of_birth": "1994-05-20",
                "phone": "+14155552671"
            },
            description="Email of existing user should return 409"
        )

        # ========== FEATURE 3: ADMIN LOGIN & SIGNUP APPROVAL ==========
        self.log("\n### FEATURE 3: ADMIN LOGIN & SIGNUP APPROVAL ###", Colors.YELLOW)
        
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

        # Get pending signup requests
        success, resp = self.test(
            "Get pending signup requests",
            "GET", "/admin/signup-requests?status=PENDING", 200,
            token=self.admin_token,
            description="List pending signup requests"
        )

        # Approve signup request
        if self.test_signup_request_id:
            success, resp = self.test(
                "Approve signup request",
                "POST", f"/admin/signup-requests/{self.test_signup_request_id}/approve", 200,
                data={
                    "username": "qa_tester_01",
                    "password": "QaPass@123",
                    "starting_chips": 1500
                },
                token=self.admin_token,
                description="Approve request and create account with username/password"
            )
            if success:
                self.test_username = resp.get('username')
                self.test_password = "QaPass@123"
                self.test_user_id = resp.get('user', {}).get('id')

            # Try approving again - should fail
            self.test(
                "Approve same request again - 400",
                "POST", f"/admin/signup-requests/{self.test_signup_request_id}/approve", 400,
                data={
                    "username": "qa_tester_02",
                    "password": "QaPass@123",
                    "starting_chips": 1500
                },
                token=self.admin_token,
                description="Approving already resolved request should return 400"
            )

        # Create another request for duplicate username test
        success, resp = self.test(
            "Create another signup request",
            "POST", "/auth/signup-request", 200,
            data={
                "full_name": "Another Tester",
                "email": "another.tester@example.com",
                "date_of_birth": "1995-06-15",
                "phone": "+14155552672"
            }
        )
        if success:
            another_request_id = resp.get('request_id')
            # Try to approve with duplicate username
            self.test(
                "Approve with duplicate username - 409",
                "POST", f"/admin/signup-requests/{another_request_id}/approve", 409,
                data={
                    "username": "qa_tester_01",
                    "password": "AnotherPass@123",
                    "starting_chips": 1000
                },
                token=self.admin_token,
                description="Duplicate username should return 409"
            )
            # Reject this request
            self.test(
                "Reject signup request",
                "POST", f"/admin/signup-requests/{another_request_id}/reject", 200,
                data={"note": "Test rejection"},
                token=self.admin_token,
                description="Reject the signup request"
            )

        # ========== FEATURE 4: USERNAME/EMAIL LOGIN ==========
        self.log("\n### FEATURE 4: USERNAME/EMAIL LOGIN ###", Colors.YELLOW)
        
        if self.test_username and self.test_password:
            # Login with username (lowercase)
            success, resp = self.test(
                "Login with username (lowercase)",
                "POST", "/auth/login", 200,
                data={"email": self.test_username, "password": self.test_password},
                description="Login with assigned username"
            )
            if success:
                self.player_token = resp.get('access_token')
                user = resp.get('user', {})
                print(f"  User: username={user.get('username')}, chips={user.get('chip_balance')}, status={user.get('status')}")

            # Login with username (uppercase) - should work
            success, resp = self.test(
                "Login with username (uppercase)",
                "POST", "/auth/login", 200,
                data={"email": "QA_TESTER_01", "password": self.test_password},
                description="Login with uppercase username should work"
            )

        # Legacy email login
        success, resp = self.test(
            "Legacy email login",
            "POST", "/auth/login", 200,
            data={"email": "player@fungame.app", "password": "Player@123"},
            description="Legacy player email login should still work"
        )
        if success:
            legacy_player_token = resp.get('access_token')
            legacy_user = resp.get('user', {})
            print(f"  Legacy user: email={legacy_user.get('email')}, chips={legacy_user.get('chip_balance')}")

        # ========== FEATURE 5: CHIPS <-> POINTS CONVERSION ==========
        self.log("\n### FEATURE 5: CHIPS <-> POINTS CONVERSION ###", Colors.YELLOW)
        
        if not self.player_token:
            self.log("❌ No player token - skipping conversion tests", Colors.RED)
        else:
            # Get initial balance
            success, resp = self.test(
                "Get chip balance (includes points)",
                "GET", "/chips/balance", 200,
                token=self.player_token,
                description="Check initial balance"
            )
            if success:
                initial_chips = resp.get('balance', 0)
                initial_points = resp.get('points', 0)
                print(f"  Initial: chips={initial_chips}, points={initial_points}")

            # Try converting less than minimum (499)
            self.test(
                "Convert chips to points - below minimum (422)",
                "POST", "/chips/convert", 422,
                data={"direction": "CHIPS_TO_POINTS", "amount": 499},
                token=self.player_token,
                description="Amount below 500 should return 422"
            )

            # Convert 500 chips to points
            success, resp = self.test(
                "Convert 500 chips to points",
                "POST", "/chips/convert", 200,
                data={"direction": "CHIPS_TO_POINTS", "amount": 500},
                token=self.player_token,
                description="Sell 500 chips for 500 points"
            )
            if success:
                new_chips = resp.get('chip_balance', 0)
                new_points = resp.get('points_balance', 0)
                print(f"  After conversion: chips={new_chips}, points={new_points}")
                print(f"  Expected: chips={initial_chips - 500}, points={initial_points + 500}")

            # Convert 500 points back to chips
            success, resp = self.test(
                "Convert 500 points to chips",
                "POST", "/chips/convert", 200,
                data={"direction": "POINTS_TO_CHIPS", "amount": 500},
                token=self.player_token,
                description="Convert 500 points back to chips"
            )
            if success:
                final_chips = resp.get('chip_balance', 0)
                final_points = resp.get('points_balance', 0)
                print(f"  After reverse: chips={final_chips}, points={final_points}")

            # Try converting more points than available
            self.test(
                "Convert points - insufficient balance (400)",
                "POST", "/chips/convert", 400,
                data={"direction": "POINTS_TO_CHIPS", "amount": 500},
                token=self.player_token,
                description="Converting more points than available should return 400"
            )

            # Get points transactions
            success, resp = self.test(
                "Get points transactions",
                "GET", "/points/transactions", 200,
                token=self.player_token,
                description="List points transaction history"
            )
            if success:
                txs = resp.get('transactions', [])
                print(f"  Found {len(txs)} points transactions")

        # ========== FEATURE 6: ADMIN POINTS ADJUSTMENT ==========
        self.log("\n### FEATURE 6: ADMIN POINTS ADJUSTMENT ###", Colors.YELLOW)
        
        if not self.admin_token or not self.test_user_id:
            self.log("❌ No admin token or test user - skipping admin points tests", Colors.RED)
        else:
            # Add 250 points
            success, resp = self.test(
                "Admin add points",
                "POST", f"/admin/users/{self.test_user_id}/points", 200,
                data={"delta": 250, "note": "Test credit"},
                token=self.admin_token,
                description="Admin adds 250 points to user"
            )
            if success:
                print(f"  New points balance: {resp.get('points_balance')}")

            # Try to deduct more than available
            self.test(
                "Admin deduct excessive points - 400",
                "POST", f"/admin/users/{self.test_user_id}/points", 400,
                data={"delta": -9999},
                token=self.admin_token,
                description="Deducting more points than available should return 400"
            )

        # ========== FEATURE 7: ADMIN STATS ==========
        self.log("\n### FEATURE 7: ADMIN STATS ###", Colors.YELLOW)
        
        if self.admin_token:
            success, resp = self.test(
                "Get admin stats (includes pending_signups)",
                "GET", "/admin/stats", 200,
                token=self.admin_token,
                description="Admin dashboard stats should include pending_signups count"
            )
            if success:
                print(f"  Stats: pending_signups={resp.get('pending_signups')}, total_users={resp.get('total_users')}")

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
    tester = APITester()
    exit_code = tester.run_all_tests()
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
