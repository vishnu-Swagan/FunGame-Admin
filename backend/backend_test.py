"""Backend API tests for FunGame slot games and confetti feature."""
import requests
import sys
import time

BASE_URL = "https://casino-reference-app.preview.emergentagent.com/api"

class SlotGameTester:
    def __init__(self):
        self.token = None
        self.tests_run = 0
        self.tests_passed = 0
        self.issues = []

    def log_pass(self, test_name):
        self.tests_run += 1
        self.tests_passed += 1
        print(f"✅ PASS: {test_name}")

    def log_fail(self, test_name, reason):
        self.tests_run += 1
        self.issues.append(f"{test_name}: {reason}")
        print(f"❌ FAIL: {test_name} - {reason}")

    def test_login(self):
        """Test player login"""
        print("\n🔐 Testing login...")
        try:
            response = requests.post(
                f"{BASE_URL}/auth/login",
                json={"email": "player@fungame.app", "password": "Player@123"},
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                if "access_token" in data:
                    self.token = data["access_token"]
                    self.log_pass("Player login")
                    return True
                else:
                    self.log_fail("Player login", "No access_token in response")
                    return False
            else:
                self.log_fail("Player login", f"Status {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_fail("Player login", str(e))
            return False

    def test_slot_state(self, slug, game_name):
        """Test GET /api/live/{slug}/state"""
        print(f"\n🎰 Testing {game_name} state endpoint...")
        try:
            headers = {"Authorization": f"Bearer {self.token}"}
            response = requests.get(f"{BASE_URL}/live/{slug}/state", headers=headers, timeout=10)
            
            if response.status_code != 200:
                self.log_fail(f"{game_name} state", f"Status {response.status_code}")
                return False
            
            data = response.json()
            
            # Check required fields
            required = ["phase", "round_number", "phase_ends_in", "timings", "balance"]
            missing = [f for f in required if f not in data]
            if missing:
                self.log_fail(f"{game_name} state", f"Missing fields: {missing}")
                return False
            
            # Check timings
            timings = data.get("timings", {})
            if timings.get("bet") != 12 or timings.get("reveal") != 5 or timings.get("result") != 3:
                self.log_fail(f"{game_name} state", f"Wrong timings: {timings}")
                return False
            
            # Check phase
            phase = data.get("phase")
            if phase not in ["BETTING", "REVEAL", "RESULT"]:
                self.log_fail(f"{game_name} state", f"Invalid phase: {phase}")
                return False
            
            # If REVEAL or RESULT, check outcome
            if phase in ["REVEAL", "RESULT"]:
                outcome = data.get("outcome")
                if not outcome:
                    self.log_fail(f"{game_name} state", "No outcome in REVEAL/RESULT phase")
                    return False
                
                if "reels" not in outcome or len(outcome["reels"]) != 3:
                    self.log_fail(f"{game_name} state", f"Invalid reels: {outcome.get('reels')}")
                    return False
                
                if "label" not in outcome or "multiplier" not in outcome:
                    self.log_fail(f"{game_name} state", "Missing label or multiplier in outcome")
                    return False
            
            self.log_pass(f"{game_name} state endpoint")
            return True
            
        except Exception as e:
            self.log_fail(f"{game_name} state", str(e))
            return False

    def test_slot_betting(self, slug, game_name):
        """Test POST /api/live/{slug}/bets and /bets/clear"""
        print(f"\n💰 Testing {game_name} betting...")
        
        # Wait for BETTING phase
        print(f"   Waiting for BETTING phase...")
        headers = {"Authorization": f"Bearer {self.token}"}
        max_wait = 25  # Max wait time in seconds
        start_time = time.time()
        
        while time.time() - start_time < max_wait:
            try:
                response = requests.get(f"{BASE_URL}/live/{slug}/state", headers=headers, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    if data.get("phase") == "BETTING":
                        print(f"   ✓ BETTING phase active")
                        break
                time.sleep(1)
            except:
                time.sleep(1)
        else:
            self.log_fail(f"{game_name} betting", "Timeout waiting for BETTING phase")
            return False
        
        # Get initial balance
        initial_balance = data.get("balance", 0)
        
        # Place bet
        try:
            response = requests.post(
                f"{BASE_URL}/live/{slug}/bets",
                json={"selection": None, "amount": 50},
                headers=headers,
                timeout=10
            )
            
            if response.status_code != 200:
                self.log_fail(f"{game_name} place bet", f"Status {response.status_code}: {response.text}")
                return False
            
            bet_data = response.json()
            new_balance = bet_data.get("balance")
            
            if new_balance != initial_balance - 50:
                self.log_fail(f"{game_name} place bet", f"Balance not deducted correctly: {initial_balance} -> {new_balance}")
                return False
            
            if bet_data.get("my_total") != 50:
                self.log_fail(f"{game_name} place bet", f"my_total should be 50, got {bet_data.get('my_total')}")
                return False
            
            self.log_pass(f"{game_name} place bet")
            
        except Exception as e:
            self.log_fail(f"{game_name} place bet", str(e))
            return False
        
        # Clear bets
        try:
            response = requests.post(
                f"{BASE_URL}/live/{slug}/bets/clear",
                headers=headers,
                timeout=10
            )
            
            if response.status_code != 200:
                self.log_fail(f"{game_name} clear bets", f"Status {response.status_code}")
                return False
            
            clear_data = response.json()
            refunded_balance = clear_data.get("balance")
            
            if refunded_balance != initial_balance:
                self.log_fail(f"{game_name} clear bets", f"Balance not refunded: {refunded_balance} vs {initial_balance}")
                return False
            
            self.log_pass(f"{game_name} clear bets")
            return True
            
        except Exception as e:
            self.log_fail(f"{game_name} clear bets", str(e))
            return False

    def run_all_tests(self):
        """Run all backend tests"""
        print("=" * 60)
        print("🎰 FUNGAME SLOT GAMES BACKEND TEST SUITE")
        print("=" * 60)
        
        # Login first
        if not self.test_login():
            print("\n❌ Login failed, cannot continue tests")
            return False
        
        # Test all three slot games
        slots = [
            ("triple-fun", "777 Triple Fun"),
            ("joker-bonus", "Joker Bonus"),
            ("lucky-8-line", "Lucky 8 Line")
        ]
        
        for slug, name in slots:
            self.test_slot_state(slug, name)
            # Only test betting for one game to save time
            if slug == "triple-fun":
                self.test_slot_betting(slug, name)
        
        # Print summary
        print("\n" + "=" * 60)
        print(f"📊 TEST SUMMARY")
        print("=" * 60)
        print(f"Total tests: {self.tests_run}")
        print(f"Passed: {self.tests_passed}")
        print(f"Failed: {self.tests_run - self.tests_passed}")
        
        if self.issues:
            print("\n❌ ISSUES FOUND:")
            for issue in self.issues:
                print(f"  - {issue}")
        else:
            print("\n✅ ALL TESTS PASSED!")
        
        return len(self.issues) == 0


if __name__ == "__main__":
    tester = SlotGameTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)
