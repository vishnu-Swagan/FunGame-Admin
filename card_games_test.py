"""
Backend API tests for FunGame card games flicker fix verification.
Tests all 5 card game endpoints and phase progression.
"""
import requests
import sys
import time
from datetime import datetime

BASE_URL = "https://casino-reference-app.preview.emergentagent.com"

class CardGameTester:
    def __init__(self):
        self.base_url = BASE_URL
        self.token = None
        self.tests_run = 0
        self.tests_passed = 0
        self.issues = []

    def log(self, msg, level="INFO"):
        """Log test messages"""
        prefix = "✅" if level == "PASS" else "❌" if level == "FAIL" else "🔍"
        print(f"{prefix} {msg}")

    def run_test(self, name, method, endpoint, expected_status, data=None, check_fn=None):
        """Run a single API test with optional validation function"""
        url = f"{self.base_url}/{endpoint}"
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'

        self.tests_run += 1
        self.log(f"Testing {name}...", "INFO")
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=10)
            else:
                self.log(f"Unsupported method: {method}", "FAIL")
                return False, {}

            success = response.status_code == expected_status
            
            if not success:
                self.log(f"Failed - Expected {expected_status}, got {response.status_code}", "FAIL")
                self.issues.append(f"{name}: Status {response.status_code} (expected {expected_status})")
                try:
                    self.log(f"Response: {response.text[:200]}", "INFO")
                except:
                    pass
                return False, {}

            try:
                response_data = response.json()
            except:
                response_data = {}

            # Run custom validation if provided
            if check_fn and not check_fn(response_data):
                self.log(f"Failed - Validation check failed", "FAIL")
                self.issues.append(f"{name}: Validation failed")
                return False, response_data

            self.tests_passed += 1
            self.log(f"Passed - Status: {response.status_code}", "PASS")
            return True, response_data

        except requests.exceptions.Timeout:
            self.log(f"Failed - Request timeout", "FAIL")
            self.issues.append(f"{name}: Timeout")
            return False, {}
        except Exception as e:
            self.log(f"Failed - Error: {str(e)}", "FAIL")
            self.issues.append(f"{name}: {str(e)}")
            return False, {}

    def test_login(self):
        """Test login and get token"""
        self.log("\n=== AUTHENTICATION ===", "INFO")
        success, response = self.run_test(
            "Login with player@fungame.app",
            "POST",
            "api/auth/login",
            200,
            data={"email": "player@fungame.app", "password": "Player@123"}
        )
        if success and 'access_token' in response:
            self.token = response['access_token']
            self.log(f"Token obtained: {self.token[:20]}...", "INFO")
            return True
        self.log("Login failed - cannot proceed with tests", "FAIL")
        return False

    def test_game_state(self, slug, game_name, expected_fields):
        """Test a live game state endpoint"""
        success, data = self.run_test(
            f"GET /api/live/{slug}/state",
            "GET",
            f"api/live/{slug}/state",
            200,
            check_fn=lambda d: all(field in d for field in expected_fields)
        )
        
        if success:
            self.log(f"  Round: {data.get('round_number')}, Phase: {data.get('phase')}, Ends in: {data.get('phase_ends_in')}s", "INFO")
            timings = data.get('timings', {})
            self.log(f"  Timings: bet={timings.get('bet')}s, reveal={timings.get('reveal')}s, result={timings.get('result')}s", "INFO")
            
            # Check outcome structure during REVEAL/RESULT
            if data.get('phase') in ['REVEAL', 'RESULT']:
                outcome = data.get('outcome')
                if outcome:
                    self.log(f"  Outcome present: {list(outcome.keys())}", "INFO")
                else:
                    self.log(f"  WARNING: No outcome during {data.get('phase')} phase", "FAIL")
                    self.issues.append(f"{game_name}: No outcome during {data.get('phase')} phase")
        
        return success, data

    def test_teen_patti_state(self):
        """Test Teen Patti state endpoint"""
        self.log("\n=== TEEN PATTI STATE ===", "INFO")
        expected = ['round_number', 'phase', 'phase_ends_in', 'timings', 'options', 'my_bets', 'last_results']
        return self.test_game_state('teen-patti', 'Teen Patti', expected)

    def test_poker_state(self):
        """Test Poker state endpoint"""
        self.log("\n=== POKER STATE ===", "INFO")
        expected = ['round_number', 'phase', 'phase_ends_in', 'timings', 'options', 'my_bets', 'last_results']
        return self.test_game_state('poker', 'Poker', expected)

    def test_no_hold_state(self):
        """Test No-Hold state endpoint"""
        self.log("\n=== NO-HOLD STATE ===", "INFO")
        expected = ['round_number', 'phase', 'phase_ends_in', 'timings', 'my_bets', 'last_results']
        return self.test_game_state('no-hold', 'No-Hold', expected)

    def test_champion_poker_state(self):
        """Test Champion Poker state endpoint"""
        self.log("\n=== CHAMPION POKER STATE ===", "INFO")
        expected = ['round_number', 'phase', 'phase_ends_in', 'timings', 'my_bets', 'last_results']
        return self.test_game_state('champion-poker', 'Champion Poker', expected)

    def test_andar_bahar_state(self):
        """Test Andar Bahar state endpoint"""
        self.log("\n=== ANDAR BAHAR STATE ===", "INFO")
        expected = ['round_number', 'phase', 'phase_ends_in', 'timings', 'options', 'my_bets', 'last_results']
        return self.test_game_state('andar-bahar', 'Andar Bahar', expected)

    def test_phase_progression(self):
        """Test that phase progression is consistent over ~20s"""
        self.log("\n=== PHASE PROGRESSION TEST ===", "INFO")
        self.log("Polling teen-patti state 5 times over 20 seconds...", "INFO")
        
        states = []
        for i in range(5):
            success, data = self.run_test(
                f"Poll {i+1}/5",
                "GET",
                "api/live/teen-patti/state",
                200
            )
            if success:
                states.append({
                    'time': time.time(),
                    'round': data.get('round_number'),
                    'phase': data.get('phase'),
                    'ends_in': data.get('phase_ends_in')
                })
                self.log(f"  Round {data.get('round_number')}, Phase: {data.get('phase')}, Ends in: {data.get('phase_ends_in')}s", "INFO")
            
            if i < 4:  # Don't sleep after last poll
                time.sleep(5)
        
        # Validate progression
        if len(states) >= 2:
            consistent = True
            for i in range(1, len(states)):
                prev, curr = states[i-1], states[i]
                
                # Check if round progressed or stayed same
                if curr['round'] < prev['round']:
                    self.log(f"ERROR: Round number went backwards! {prev['round']} -> {curr['round']}", "FAIL")
                    self.issues.append("Phase progression: Round number decreased")
                    consistent = False
                
                # Check if phase_ends_in decreased (within same phase)
                if curr['round'] == prev['round'] and curr['phase'] == prev['phase']:
                    time_diff = curr['time'] - prev['time']
                    expected_decrease = prev['ends_in'] - time_diff
                    actual_decrease = prev['ends_in'] - curr['ends_in']
                    
                    # Allow 2s tolerance for network latency
                    if abs(actual_decrease - time_diff) > 2:
                        self.log(f"WARNING: phase_ends_in not decreasing consistently", "INFO")
            
            if consistent:
                self.log("Phase progression appears consistent", "PASS")
                return True
        
        return False

    def test_bet_placement(self):
        """Test placing a bet during BETTING phase"""
        self.log("\n=== BET PLACEMENT TEST ===", "INFO")
        
        # First, check current phase
        success, state = self.run_test(
            "Check teen-patti phase",
            "GET",
            "api/live/teen-patti/state",
            200
        )
        
        if not success:
            self.log("Cannot check phase - skipping bet test", "FAIL")
            return False
        
        phase = state.get('phase')
        self.log(f"Current phase: {phase}", "INFO")
        
        if phase != 'BETTING':
            self.log(f"Not in BETTING phase (currently {phase}) - waiting for next betting window...", "INFO")
            # Wait for next betting phase (max 40s)
            for _ in range(8):
                time.sleep(5)
                success, state = self.run_test(
                    "Check phase again",
                    "GET",
                    "api/live/teen-patti/state",
                    200
                )
                if success and state.get('phase') == 'BETTING':
                    self.log("BETTING phase started!", "INFO")
                    break
            else:
                self.log("Timeout waiting for BETTING phase - skipping bet test", "FAIL")
                return False
        
        # Place a bet
        initial_balance = state.get('balance', 0)
        self.log(f"Initial balance: {initial_balance} chips", "INFO")
        
        success, bet_response = self.run_test(
            "Place bet on Player side (50 chips)",
            "POST",
            "api/live/teen-patti/bets",
            200,
            data={"selection": "player", "amount": 50}
        )
        
        if success:
            new_balance = bet_response.get('balance', 0)
            self.log(f"New balance: {new_balance} chips (deducted: {initial_balance - new_balance})", "INFO")
            
            if initial_balance - new_balance != 50:
                self.log(f"WARNING: Balance deduction mismatch", "FAIL")
                self.issues.append("Bet placement: Balance not deducted correctly")
            
            # Test clearing bets
            success_clear, clear_response = self.run_test(
                "Clear bets (refund)",
                "POST",
                "api/live/teen-patti/bets/clear",
                200
            )
            
            if success_clear:
                refunded = clear_response.get('refunded', 0)
                final_balance = clear_response.get('balance', 0)
                self.log(f"Refunded: {refunded} chips, Final balance: {final_balance}", "INFO")
                
                if refunded != 50:
                    self.log(f"WARNING: Refund amount mismatch", "FAIL")
                    self.issues.append("Bet clearing: Refund amount incorrect")
                
                return True
        
        return False

    def print_summary(self):
        """Print test summary"""
        self.log("\n" + "="*60, "INFO")
        self.log("TEST SUMMARY", "INFO")
        self.log("="*60, "INFO")
        self.log(f"Tests run: {self.tests_run}", "INFO")
        self.log(f"Tests passed: {self.tests_passed}", "PASS" if self.tests_passed == self.tests_run else "FAIL")
        self.log(f"Tests failed: {self.tests_run - self.tests_passed}", "FAIL" if self.tests_run > self.tests_passed else "INFO")
        
        if self.issues:
            self.log("\nISSUES FOUND:", "FAIL")
            for issue in self.issues:
                self.log(f"  - {issue}", "FAIL")
        else:
            self.log("\nNo issues found! All backend tests passed.", "PASS")
        
        success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
        self.log(f"\nSuccess rate: {success_rate:.1f}%", "INFO")
        
        return self.tests_passed == self.tests_run


def main():
    """Run all backend tests"""
    print(f"\n{'='*60}")
    print("FunGame Card Games Backend Test Suite")
    print(f"Testing flicker fix verification")
    print(f"Base URL: {BASE_URL}")
    print(f"{'='*60}\n")
    
    tester = CardGameTester()
    
    # Authentication
    if not tester.test_login():
        print("\n❌ Cannot proceed without authentication")
        return 1
    
    # Test all 5 card game state endpoints
    tester.test_teen_patti_state()
    tester.test_poker_state()
    tester.test_no_hold_state()
    tester.test_champion_poker_state()
    tester.test_andar_bahar_state()
    
    # Test phase progression
    tester.test_phase_progression()
    
    # Test bet placement and clearing
    tester.test_bet_placement()
    
    # Print summary
    all_passed = tester.print_summary()
    
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
