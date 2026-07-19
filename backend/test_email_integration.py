"""Backend API tests for Resend email integration in FunGame auth flows.

Tests verify:
- Email delivery failure handling (Resend test mode rejects unknown recipients)
- No dev_code exposure when EMAIL_PROVIDER=resend
- Anti-enumeration in forgot-password
- Regression: core auth flows still work
"""
import requests
import sys
import time
from datetime import datetime
from pymongo import MongoClient
import os

BASE_URL = "https://casino-reference-app.preview.emergentagent.com/api"

class EmailIntegrationTester:
    def __init__(self):
        self.tests_run = 0
        self.tests_passed = 0
        self.issues = []
        self.test_emails = []  # Track for cleanup
        
        # MongoDB connection for cleanup
        mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
        self.mongo_client = MongoClient(mongo_url)
        self.db = self.mongo_client['test_database']

    def log_pass(self, test_name):
        self.tests_run += 1
        self.tests_passed += 1
        print(f"✅ PASS: {test_name}")

    def log_fail(self, test_name, reason):
        self.tests_run += 1
        self.issues.append(f"{test_name}: {reason}")
        print(f"❌ FAIL: {test_name} - {reason}")

    def cleanup_test_user(self, email):
        """Delete test user from MongoDB"""
        try:
            result = self.db.users.delete_one({'email': email})
            if result.deleted_count > 0:
                print(f"   🗑️  Deleted test user: {email}")
            return True
        except Exception as e:
            print(f"   ⚠️  Cleanup warning for {email}: {e}")
            return False

    def test_register_rejected_recipient(self):
        """Test 1: Register with random @example.com email (Resend rejects)"""
        print("\n📧 Test 1: Register with rejected recipient (@example.com)...")
        
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        email = f"qa-resend-{timestamp}@example.com"
        self.test_emails.append(email)
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/register",
                json={"email": email, "password": "TestPass123!"},
                timeout=15
            )
            
            if response.status_code != 200:
                self.log_fail("Register rejected recipient", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Must have email_delivery='failed'
            if data.get('email_delivery') != 'failed':
                self.log_fail("Register rejected recipient", f"Expected email_delivery='failed', got {data.get('email_delivery')}")
                return False
            
            # Must have friendly message about delivery failure
            message = data.get('message', '')
            if 'could not be delivered' not in message.lower():
                self.log_fail("Register rejected recipient", f"Message doesn't mention delivery failure: {message}")
                return False
            
            # Must NOT have dev_code (EMAIL_PROVIDER=resend, not demo)
            if 'dev_code' in data:
                self.log_fail("Register rejected recipient", f"dev_code exposed in resend mode: {data.get('dev_code')}")
                return False
            
            # Must have email field
            if data.get('email') != email:
                self.log_fail("Register rejected recipient", f"Email mismatch: {data.get('email')}")
                return False
            
            self.log_pass("Register rejected recipient (email_delivery='failed', no dev_code)")
            return True
            
        except Exception as e:
            self.log_fail("Register rejected recipient", str(e))
            return False

    def test_register_delivered_recipient(self):
        """Test 2: Register with delivered@resend.dev (Resend accepts)"""
        print("\n📧 Test 2: Register with delivered@resend.dev (accepted recipient)...")
        
        email = "delivered@resend.dev"
        
        # Clean up first if exists
        self.cleanup_test_user(email)
        self.test_emails.append(email)
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/register",
                json={"email": email, "password": "TestPass123!"},
                timeout=15
            )
            
            if response.status_code != 200:
                self.log_fail("Register delivered@resend.dev", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Must have success message
            message = data.get('message', '')
            if 'verification code sent' not in message.lower():
                self.log_fail("Register delivered@resend.dev", f"Expected success message, got: {message}")
                return False
            
            # Must NOT have email_delivery field (successful send)
            if 'email_delivery' in data:
                self.log_fail("Register delivered@resend.dev", f"email_delivery field present on success: {data.get('email_delivery')}")
                return False
            
            # Must NOT have dev_code
            if 'dev_code' in data:
                self.log_fail("Register delivered@resend.dev", f"dev_code exposed: {data.get('dev_code')}")
                return False
            
            # Must have email
            if data.get('email') != email:
                self.log_fail("Register delivered@resend.dev", f"Email mismatch: {data.get('email')}")
                return False
            
            self.log_pass("Register delivered@resend.dev (success, no email_delivery, no dev_code)")
            return True
            
        except Exception as e:
            self.log_fail("Register delivered@resend.dev", str(e))
            return False

    def test_resend_verification(self):
        """Test 3: Resend verification for delivered@resend.dev"""
        print("\n📧 Test 3: Resend verification code...")
        
        email = "delivered@resend.dev"
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/resend-verification",
                json={"email": email},
                timeout=15
            )
            
            if response.status_code != 200:
                self.log_fail("Resend verification", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Must have success message
            message = data.get('message', '')
            if 'verification code re-sent' not in message.lower():
                self.log_fail("Resend verification", f"Expected success message, got: {message}")
                return False
            
            # Must NOT have dev_code
            if 'dev_code' in data:
                self.log_fail("Resend verification", f"dev_code exposed: {data.get('dev_code')}")
                return False
            
            self.log_pass("Resend verification (no dev_code)")
            return True
            
        except Exception as e:
            self.log_fail("Resend verification", str(e))
            return False

    def test_reregister_unverified(self):
        """Test 4: Re-register same unverified email (rejected recipient)"""
        print("\n📧 Test 4: Re-register unverified email...")
        
        # Use the first test email (unverified @example.com)
        if not self.test_emails:
            print("   ⚠️  Skipping (no test email from Test 1)")
            return True
        
        email = self.test_emails[0]
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/register",
                json={"email": email, "password": "NewPass456!"},
                timeout=15
            )
            
            if response.status_code != 200:
                self.log_fail("Re-register unverified", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Must have email_delivery='failed' (re-send also fails)
            if data.get('email_delivery') != 'failed':
                self.log_fail("Re-register unverified", f"Expected email_delivery='failed', got {data.get('email_delivery')}")
                return False
            
            # Must have message about re-sending
            message = data.get('message', '')
            if 're-sent' not in message.lower():
                self.log_fail("Re-register unverified", f"Expected re-sent message, got: {message}")
                return False
            
            # Must NOT have dev_code
            if 'dev_code' in data:
                self.log_fail("Re-register unverified", f"dev_code exposed: {data.get('dev_code')}")
                return False
            
            self.log_pass("Re-register unverified (email_delivery='failed', no dev_code)")
            return True
            
        except Exception as e:
            self.log_fail("Re-register unverified", str(e))
            return False

    def test_forgot_password_existing(self):
        """Test 5: Forgot password for existing user (player@fungame.app)"""
        print("\n📧 Test 5: Forgot password for existing user...")
        
        email = "player@fungame.app"
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/forgot-password",
                json={"email": email},
                timeout=15
            )
            
            if response.status_code != 200:
                self.log_fail("Forgot password existing", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Must have generic anti-enumeration message
            message = data.get('message', '')
            if 'if an account exists' not in message.lower():
                self.log_fail("Forgot password existing", f"Expected generic message, got: {message}")
                return False
            
            # Must NOT have dev_code (EMAIL_PROVIDER=resend)
            if 'dev_code' in data:
                self.log_fail("Forgot password existing", f"dev_code exposed: {data.get('dev_code')}")
                return False
            
            # Must NOT have email_delivery field (anti-enumeration)
            if 'email_delivery' in data:
                self.log_fail("Forgot password existing", f"email_delivery field leaks account existence: {data.get('email_delivery')}")
                return False
            
            self.log_pass("Forgot password existing (generic message, no dev_code, no email_delivery)")
            return True
            
        except Exception as e:
            self.log_fail("Forgot password existing", str(e))
            return False

    def test_forgot_password_nonexistent(self):
        """Test 6: Forgot password for non-existent email"""
        print("\n📧 Test 6: Forgot password for non-existent email...")
        
        email = "nonexistent-user-12345@example.com"
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/forgot-password",
                json={"email": email},
                timeout=15
            )
            
            if response.status_code != 200:
                self.log_fail("Forgot password nonexistent", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Must have same generic message (anti-enumeration)
            message = data.get('message', '')
            if 'if an account exists' not in message.lower():
                self.log_fail("Forgot password nonexistent", f"Expected generic message, got: {message}")
                return False
            
            # Must NOT have dev_code
            if 'dev_code' in data:
                self.log_fail("Forgot password nonexistent", f"dev_code exposed: {data.get('dev_code')}")
                return False
            
            # Must NOT have email_delivery
            if 'email_delivery' in data:
                self.log_fail("Forgot password nonexistent", f"email_delivery field present: {data.get('email_delivery')}")
                return False
            
            self.log_pass("Forgot password nonexistent (same generic response)")
            return True
            
        except Exception as e:
            self.log_fail("Forgot password nonexistent", str(e))
            return False

    def test_regression_login(self):
        """Test 7: Regression - Login with player@fungame.app"""
        print("\n🔐 Test 7: Regression - Player login...")
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/login",
                json={"email": "player@fungame.app", "password": "Player@123"},
                timeout=10
            )
            
            if response.status_code != 200:
                self.log_fail("Regression login", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            if 'access_token' not in data:
                self.log_fail("Regression login", "No access_token in response")
                return False
            
            self.token = data['access_token']
            self.log_pass("Regression login")
            return True
            
        except Exception as e:
            self.log_fail("Regression login", str(e))
            return False

    def test_regression_me(self):
        """Test 8: Regression - GET /me with token"""
        print("\n👤 Test 8: Regression - GET /me...")
        
        if not hasattr(self, 'token'):
            print("   ⚠️  Skipping (no token from login)")
            return True
        
        try:
            response = requests.get(
                f"{BASE_URL}/auth/me",
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=10
            )
            
            if response.status_code != 200:
                self.log_fail("Regression /me", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            if 'user' not in data:
                self.log_fail("Regression /me", "No user in response")
                return False
            
            user = data['user']
            if user.get('email') != 'player@fungame.app':
                self.log_fail("Regression /me", f"Wrong user email: {user.get('email')}")
                return False
            
            self.log_pass("Regression /me")
            return True
            
        except Exception as e:
            self.log_fail("Regression /me", str(e))
            return False

    def test_regression_wrong_password(self):
        """Test 9: Regression - Login with wrong password"""
        print("\n🔐 Test 9: Regression - Wrong password...")
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/login",
                json={"email": "player@fungame.app", "password": "WrongPassword123!"},
                timeout=10
            )
            
            if response.status_code != 401:
                self.log_fail("Regression wrong password", f"Expected 401, got {response.status_code}")
                return False
            
            self.log_pass("Regression wrong password (401)")
            return True
            
        except Exception as e:
            self.log_fail("Regression wrong password", str(e))
            return False

    def test_regression_duplicate_verified(self):
        """Test 10: Regression - Register with verified email"""
        print("\n📧 Test 10: Regression - Duplicate verified email...")
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/register",
                json={"email": "player@fungame.app", "password": "AnyPass123!"},
                timeout=10
            )
            
            if response.status_code != 409:
                self.log_fail("Regression duplicate verified", f"Expected 409, got {response.status_code}")
                return False
            
            self.log_pass("Regression duplicate verified (409)")
            return True
            
        except Exception as e:
            self.log_fail("Regression duplicate verified", str(e))
            return False

    def test_regression_teen_patti(self):
        """Test 11: Regression - GET /api/live/teen-patti/state"""
        print("\n🎰 Test 11: Regression - Teen Patti state...")
        
        if not hasattr(self, 'token'):
            print("   ⚠️  Skipping (no token)")
            return True
        
        try:
            response = requests.get(
                f"{BASE_URL}/live/teen-patti/state",
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=10
            )
            
            if response.status_code != 200:
                self.log_fail("Regression teen-patti", f"Expected 200, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Check basic structure
            if 'phase' not in data or 'round_number' not in data:
                self.log_fail("Regression teen-patti", f"Missing required fields: {data.keys()}")
                return False
            
            self.log_pass("Regression teen-patti state")
            return True
            
        except Exception as e:
            self.log_fail("Regression teen-patti", str(e))
            return False

    def cleanup_all_test_users(self):
        """Test 12: Cleanup - Delete all test users"""
        print("\n🗑️  Test 12: Cleanup test users...")
        
        cleaned = 0
        for email in self.test_emails:
            if self.cleanup_test_user(email):
                cleaned += 1
        
        print(f"   ✓ Cleaned up {cleaned}/{len(self.test_emails)} test users")
        return True

    def run_all_tests(self):
        """Run all email integration tests"""
        print("=" * 70)
        print("📧 FUNGAME RESEND EMAIL INTEGRATION TEST SUITE")
        print("=" * 70)
        print(f"Base URL: {BASE_URL}")
        print(f"MongoDB: {self.db.client.address}")
        print("=" * 70)
        
        # Run tests in order
        self.test_register_rejected_recipient()
        self.test_register_delivered_recipient()
        self.test_resend_verification()
        self.test_reregister_unverified()
        self.test_forgot_password_existing()
        self.test_forgot_password_nonexistent()
        self.test_regression_login()
        self.test_regression_me()
        self.test_regression_wrong_password()
        self.test_regression_duplicate_verified()
        self.test_regression_teen_patti()
        self.cleanup_all_test_users()
        
        # Print summary
        print("\n" + "=" * 70)
        print(f"📊 TEST SUMMARY")
        print("=" * 70)
        print(f"Total tests: {self.tests_run}")
        print(f"Passed: {self.tests_passed}")
        print(f"Failed: {self.tests_run - self.tests_passed}")
        print(f"Success rate: {(self.tests_passed/self.tests_run*100):.1f}%")
        
        if self.issues:
            print("\n❌ ISSUES FOUND:")
            for issue in self.issues:
                print(f"  - {issue}")
        else:
            print("\n✅ ALL TESTS PASSED!")
        
        # Close MongoDB connection
        self.mongo_client.close()
        
        return len(self.issues) == 0


if __name__ == "__main__":
    tester = EmailIntegrationTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)
