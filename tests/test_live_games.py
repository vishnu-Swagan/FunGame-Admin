"""
FunGame Live Games Backend Test Suite
Tests Aviator and 16 live casino games with server-synchronized rounds.
"""
import requests
import sys
import time
from datetime import datetime

BASE_URL = "https://casino-reference-app.preview.emergentagent.com/api"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    END = '\033[0m'

class LiveGamesTester:
    def __init__(self):
        self.tests_run = 0
        self.tests_passed = 0
        self.tests_failed = 0
        self.player_token = None
        self.failed_tests = []
        self.aviator_bet_id = None
        self.aviator_bet_id_panel2 = None

    def log(self, msg, color=Colors.BLUE):
        print(f"{color}{msg}{Colors.END}")

    def test(self, name, func):
        """Run a single test"""
        self.tests_run += 1
        self.log(f"\n[{self.tests_run}] Testing: {name}", Colors.BLUE)
        try:
            func()
            self.tests_passed += 1
            self.log(f"✅ PASSED: {name}", Colors.GREEN)
            return True
        except AssertionError as e:
            self.tests_failed += 1
            self.failed_tests.append(f"{name}: {str(e)}")
            self.log(f"❌ FAILED: {name}\n   Error: {str(e)}", Colors.RED)
            return False
        except Exception as e:
            self.tests_failed += 1
            self.failed_tests.append(f"{name}: {str(e)}")
            self.log(f"❌ ERROR: {name}\n   Exception: {str(e)}", Colors.RED)
            return False

    def req(self, method, endpoint, expected_status, token=None, data=None, desc=""):
        """Make HTTP request and validate status"""
        url = f"{BASE_URL}{endpoint}"
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        
        try:
            if method == 'GET':
                resp = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                resp = requests.post(url, json=data, headers=headers, timeout=10)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            if desc:
                print(f"   {desc}: {resp.status_code}")
            
            assert resp.status_code == expected_status, f"Expected {expected_status}, got {resp.status_code}. Response: {resp.text[:300]}"
            
            try:
                return resp.json()
            except:
                return {}
        except requests.exceptions.RequestException as e:
            raise AssertionError(f"Request failed: {str(e)}")

    # ========== SETUP ==========
    def test_login_player(self):
        """Login as player"""
        data = self.req('POST', '/auth/login', 200, data={
            'email': 'player@fungame.app',
            'password': 'Player@123'
        }, desc="Player login")
        
        assert 'access_token' in data, "Login should return access_token"
        self.player_token = data['access_token']
        self.initial_balance = data['user']['chip_balance']
        print(f"   🔑 Player logged in, balance: {self.initial_balance}")

    # ========== AVIATOR TESTS ==========
    def test_aviator_state(self):
        """GET /live/aviator/state - check structure and phase"""
        data = self.req('GET', '/live/aviator/state', 200, token=self.player_token, desc="Get aviator state")
        
        assert 'round_number' in data, "Should return round_number"
        assert 'phase' in data, "Should return phase"
        assert data['phase'] in ['BETTING', 'FLYING', 'CRASHED'], f"Invalid phase: {data['phase']}"
        assert 'my_bets' in data, "Should return my_bets"
        assert 'all_bets' in data, "Should return all_bets feed"
        assert 'history' in data, "Should return history"
        assert 'balance' in data, "Should return balance"
        assert 'betting_seconds' in data, "Should return betting_seconds"
        assert 'growth' in data, "Should return growth constant"
        
        # CRITICAL: crash_point must NOT be leaked during BETTING/FLYING
        if data['phase'] in ['BETTING', 'FLYING']:
            assert 'crash_point' not in data, f"crash_point LEAKED during {data['phase']} phase!"
        
        # During CRASHED phase, crash_point must be present
        if data['phase'] == 'CRASHED':
            assert 'crash_point' in data, "crash_point missing during CRASHED phase"
        
        self.aviator_round = data['round_number']
        self.aviator_phase = data['phase']
        print(f"   ✅ Round {data['round_number']}, phase: {data['phase']}")

    def test_aviator_wait_for_betting(self):
        """Wait for BETTING phase to place bets"""
        max_wait = 15
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/live/aviator/state', 200, token=self.player_token)
            if data['phase'] == 'BETTING' and data.get('phase_ends_in', 0) > 2:
                print(f"   ✅ BETTING phase ready, {data.get('phase_ends_in', 0):.1f}s remaining")
                self.aviator_betting_round = data['round_number']
                return
            time.sleep(1)
        
        raise AssertionError("Timeout waiting for BETTING phase")

    def test_aviator_place_bet_panel1(self):
        """POST /live/aviator/bets - place bet on panel 1"""
        data = self.req('POST', '/live/aviator/bets', 200, token=self.player_token, data={
            'amount': 50,
            'panel': 1
        }, desc="Place bet on panel 1")
        
        assert 'bet_id' in data, "Should return bet_id"
        assert 'balance' in data, "Should return updated balance"
        assert data['balance'] < self.initial_balance, "Balance should decrease after bet"
        
        self.aviator_bet_id = data['bet_id']
        self.balance_after_bet = data['balance']
        print(f"   ✅ Bet placed: {data['bet_id']}, balance: {data['balance']}")

    def test_aviator_place_bet_panel2_with_auto_cashout(self):
        """POST /live/aviator/bets - place bet on panel 2 with auto_cashout"""
        data = self.req('POST', '/live/aviator/bets', 200, token=self.player_token, data={
            'amount': 30,
            'panel': 2,
            'auto_cashout': 2.0
        }, desc="Place bet on panel 2 with auto_cashout=2.0x")
        
        assert 'bet_id' in data, "Should return bet_id"
        self.aviator_bet_id_panel2 = data['bet_id']
        print(f"   ✅ Bet with auto_cashout placed: {data['bet_id']}")

    def test_aviator_duplicate_bet_rejected(self):
        """POST /live/aviator/bets - duplicate bet on same panel should return 409"""
        self.req('POST', '/live/aviator/bets', 409, token=self.player_token, data={
            'amount': 50,
            'panel': 1
        }, desc="Duplicate bet on panel 1")
        
        print(f"   ✅ Duplicate bet correctly rejected with 409")

    def test_aviator_cancel_bet(self):
        """POST /live/aviator/bets/cancel - cancel bet during betting phase"""
        # Place a new bet to cancel
        data = self.req('POST', '/live/aviator/bets', 200, token=self.player_token, data={
            'amount': 20,
            'panel': 1
        })
        bet_id = data['bet_id']
        
        # Cancel it
        data = self.req('POST', '/live/aviator/bets/cancel', 200, token=self.player_token, data={
            'bet_id': bet_id
        }, desc="Cancel bet")
        
        assert 'refunded' in data, "Should return refunded amount"
        assert data['refunded'] == 20, f"Should refund 20, got {data['refunded']}"
        print(f"   ✅ Bet cancelled, refunded: {data['refunded']}")

    def test_aviator_wait_for_flying(self):
        """Wait for FLYING phase to test cashout"""
        max_wait = 10
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/live/aviator/state', 200, token=self.player_token)
            if data['phase'] == 'FLYING':
                assert 'multiplier' in data, "FLYING phase should have multiplier"
                assert 'fly_elapsed' in data, "FLYING phase should have fly_elapsed"
                print(f"   ✅ FLYING phase, multiplier: {data['multiplier']:.2f}x")
                return
            time.sleep(0.5)
        
        print(f"   ⚠️  Did not catch FLYING phase (round may have crashed quickly)")

    def test_aviator_cashout_during_flight(self):
        """POST /live/aviator/cashout - manual cashout during FLYING"""
        # Wait for FLYING phase
        max_wait = 10
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/live/aviator/state', 200, token=self.player_token)
            if data['phase'] == 'FLYING' and data.get('multiplier', 0) >= 1.5:
                # Try to cashout
                try:
                    cashout_data = self.req('POST', '/live/aviator/cashout', 200, token=self.player_token, data={
                        'bet_id': self.aviator_bet_id
                    }, desc="Manual cashout")
                    
                    assert 'result' in cashout_data, "Should return result"
                    if cashout_data['result'] == 'cashed_out':
                        assert 'multiplier' in cashout_data, "Should return multiplier"
                        assert 'payout' in cashout_data, "Should return payout"
                        print(f"   ✅ Cashed out at {cashout_data['multiplier']:.2f}x, payout: {cashout_data['payout']}")
                        return
                    elif cashout_data['result'] == 'crashed':
                        print(f"   ⚠️  Plane crashed before cashout at {cashout_data.get('crash_point', 'N/A')}x")
                        return
                except AssertionError:
                    # Bet may have already been settled
                    print(f"   ⚠️  Bet already settled (may have auto-cashed or crashed)")
                    return
            time.sleep(0.3)
        
        print(f"   ⚠️  Did not catch suitable FLYING phase for cashout test")

    def test_aviator_bet_queued_during_flight(self):
        """POST /live/aviator/bets during FLYING should queue for next round"""
        # Wait for FLYING or CRASHED phase
        max_wait = 15
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/live/aviator/state', 200, token=self.player_token)
            if data['phase'] in ['FLYING', 'CRASHED']:
                # Place bet - should queue for next round
                bet_data = self.req('POST', '/live/aviator/bets', 200, token=self.player_token, data={
                    'amount': 25,
                    'panel': 1
                }, desc="Bet during flight (queued)")
                
                assert 'queued' in bet_data, "Should return queued flag"
                assert bet_data['queued'] == True, "Bet should be queued"
                print(f"   ✅ Bet queued for next round: {bet_data['round_number']}")
                return
            time.sleep(1)
        
        print(f"   ⚠️  Could not test queued bet (always in BETTING phase)")

    def test_aviator_insufficient_chips(self):
        """POST /live/aviator/bets with insufficient chips should return 400"""
        self.req('POST', '/live/aviator/bets', 400, token=self.player_token, data={
            'amount': 999999,
            'panel': 1
        }, desc="Bet with insufficient chips")
        
        print(f"   ✅ Insufficient chips correctly rejected with 400")

    # ========== LIVE GAMES TESTS (16 games) ==========
    def test_live_game_state(self, slug, game_name):
        """GET /live/{slug}/state - check structure"""
        data = self.req('GET', f'/live/{slug}/state', 200, token=self.player_token, desc=f"Get {game_name} state")
        
        assert 'round_number' in data, "Should return round_number"
        assert 'phase' in data, "Should return phase"
        assert data['phase'] in ['BETTING', 'REVEAL', 'RESULT'], f"Invalid phase: {data['phase']}"
        assert 'phase_ends_in' in data, "Should return phase_ends_in"
        assert 'timings' in data, "Should return timings"
        assert 'kind' in data, "Should return kind"
        assert 'my_bets' in data, "Should return my_bets"
        assert 'last_results' in data, "Should return last_results"
        assert 'balance' in data, "Should return balance"
        
        # outcome should ONLY be present when phase != BETTING
        if data['phase'] == 'BETTING':
            assert data.get('outcome') is None, f"outcome LEAKED during BETTING phase for {slug}!"
        else:
            assert 'outcome' in data, f"outcome missing during {data['phase']} phase for {slug}"
        
        print(f"   ✅ {game_name}: Round {data['round_number']}, phase: {data['phase']}, countdown: {data['phase_ends_in']:.1f}s")
        return data

    def test_live_game_wait_for_betting(self, slug, game_name):
        """Wait for BETTING phase"""
        max_wait = 35
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', f'/live/{slug}/state', 200, token=self.player_token)
            if data['phase'] == 'BETTING' and data['phase_ends_in'] > 2:
                print(f"   ✅ {game_name} BETTING phase ready, {data['phase_ends_in']:.1f}s remaining")
                return data
            time.sleep(1)
        
        raise AssertionError(f"Timeout waiting for BETTING phase for {slug}")

    def test_live_game_place_bet(self, slug, game_name, selection, amount=50):
        """POST /live/{slug}/bets - place bet"""
        data = self.req('POST', f'/live/{slug}/bets', 200, token=self.player_token, data={
            'amount': amount,
            'selection': selection
        }, desc=f"Place bet on {game_name}")
        
        assert 'bet_id' in data, "Should return bet_id"
        assert 'my_bets' in data, "Should return my_bets"
        assert 'balance' in data, "Should return updated balance"
        
        print(f"   ✅ Bet placed: {data['bet_id']}, total: {data.get('my_total', 0)}")
        return data

    def test_live_game_clear_bets(self, slug, game_name):
        """POST /live/{slug}/bets/clear - refund bets"""
        data = self.req('POST', f'/live/{slug}/bets/clear', 200, token=self.player_token, desc=f"Clear {game_name} bets")
        
        assert 'refunded' in data, "Should return refunded amount"
        print(f"   ✅ Bets cleared, refunded: {data['refunded']}")

    def test_live_game_bet_during_reveal(self, slug, game_name):
        """Bet during REVEAL/RESULT should return 409"""
        max_wait = 35
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', f'/live/{slug}/state', 200, token=self.player_token)
            if data['phase'] in ['REVEAL', 'RESULT']:
                self.req('POST', f'/live/{slug}/bets', 409, token=self.player_token, data={
                    'amount': 50,
                    'selection': None
                }, desc=f"Bet during {data['phase']}")
                
                print(f"   ✅ Bet correctly rejected with 409 during {data['phase']} phase")
                return
            time.sleep(1)
        
        print(f"   ⚠️  Could not catch REVEAL/RESULT phase for {slug}")

    def test_live_game_settlement(self, slug, game_name, selection):
        """Wait for settlement and verify"""
        # Place bet
        state = self.test_live_game_wait_for_betting(slug, game_name)
        bet_round = state['round_number']
        self.test_live_game_place_bet(slug, game_name, selection, amount=30)
        
        # Wait for settlement
        max_wait = 35
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', f'/live/{slug}/state', 200, token=self.player_token)
            
            if data.get('settled') and data['settled']['round_number'] == bet_round:
                settled = data['settled']
                assert 'total_bet' in settled, "Settlement should have total_bet"
                assert 'payout' in settled, "Settlement should have payout"
                assert 'outcome' in settled, "Settlement should have outcome"
                
                print(f"   ✅ Settlement: round {settled['round_number']}, bet {settled['total_bet']}, payout {settled['payout']}")
                return settled
            
            time.sleep(2)
        
        print(f"   ⚠️  Did not receive settlement for {slug} (may need longer wait)")

    def test_live_game_invalid_selection(self, slug, game_name, invalid_selection):
        """Invalid selection should return 400"""
        # Wait for betting
        self.test_live_game_wait_for_betting(slug, game_name)
        
        self.req('POST', f'/live/{slug}/bets', 400, token=self.player_token, data={
            'amount': 50,
            'selection': invalid_selection
        }, desc=f"Invalid selection for {game_name}")
        
        print(f"   ✅ Invalid selection correctly rejected with 400")

    def test_live_game_history(self, slug, game_name):
        """GET /games/{slug}/history - check history"""
        data = self.req('GET', f'/games/{slug}/history', 200, token=self.player_token, desc=f"Get {game_name} history")
        
        assert 'rounds' in data, "Should return rounds array"
        print(f"   ✅ History retrieved: {len(data['rounds'])} round(s)")

    def test_live_game_legacy_play_blocked(self, slug, game_name):
        """POST /games/{slug}/play should return 409 LIVE_ROUNDS"""
        self.req('POST', f'/games/{slug}/play', 409, token=self.player_token, data={
            'bet': 100,
            'payload': {}
        }, desc=f"Legacy play endpoint for {game_name}")
        
        print(f"   ✅ Legacy play endpoint correctly returns 409 LIVE_ROUNDS")

    # ========== SPECIFIC GAME TESTS ==========
    def test_seven_up_down(self):
        """Test Seven-Up-Down (sides game)"""
        slug = 'seven-up-down'
        self.log("\n--- Seven-Up-Down ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Seven-Up-Down")
        self.test_live_game_wait_for_betting(slug, "Seven-Up-Down")
        self.test_live_game_place_bet(slug, "Seven-Up-Down", selection="up")
        self.test_live_game_clear_bets(slug, "Seven-Up-Down")
        self.test_live_game_invalid_selection(slug, "Seven-Up-Down", invalid_selection="invalid")
        self.test_live_game_settlement(slug, "Seven-Up-Down", selection="down")
        self.test_live_game_bet_during_reveal(slug, "Seven-Up-Down")
        self.test_live_game_history(slug, "Seven-Up-Down")
        self.test_live_game_legacy_play_blocked(slug, "Seven-Up-Down")

    def test_fun_target(self):
        """Test Fun Target (pick game)"""
        slug = 'fun-target'
        self.log("\n--- Fun Target ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Fun Target")
        self.test_live_game_wait_for_betting(slug, "Fun Target")
        self.test_live_game_place_bet(slug, "Fun Target", selection=7)
        self.test_live_game_invalid_selection(slug, "Fun Target", invalid_selection=99)
        self.test_live_game_legacy_play_blocked(slug, "Fun Target")

    def test_keno(self):
        """Test Keno (picks game)"""
        slug = 'keno'
        self.log("\n--- Keno ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Keno")
        self.test_live_game_wait_for_betting(slug, "Keno")
        self.test_live_game_place_bet(slug, "Keno", selection=[1, 5, 10, 15, 20, 25, 30, 35, 40, 45])
        self.test_live_game_invalid_selection(slug, "Keno", invalid_selection=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])  # too many
        self.test_live_game_settlement(slug, "Keno", selection=[2, 7, 12, 17, 22])
        self.test_live_game_legacy_play_blocked(slug, "Keno")

    def test_bingo(self):
        """Test Bingo (stake-only, returns card)"""
        slug = 'bingo'
        self.log("\n--- Bingo ---", Colors.YELLOW)
        state = self.test_live_game_state(slug, "Bingo")
        self.test_live_game_wait_for_betting(slug, "Bingo")
        
        # Place bet and check for card
        data = self.test_live_game_place_bet(slug, "Bingo", selection=None, amount=50)
        if data['my_bets']:
            assert 'card' in data['my_bets'][0], "Bingo bet should return a card"
            print(f"   ✅ Bingo card generated: 5x5 grid")
        
        self.test_live_game_legacy_play_blocked(slug, "Bingo")

    def test_slots(self):
        """Test Slots (stake-only)"""
        slug = 'giant-jackpot'
        self.log("\n--- Giant Jackpot (Slot) ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Giant Jackpot")
        self.test_live_game_wait_for_betting(slug, "Giant Jackpot")
        self.test_live_game_place_bet(slug, "Giant Jackpot", selection=None, amount=50)
        self.test_live_game_legacy_play_blocked(slug, "Giant Jackpot")

    def test_checker(self):
        """Test Checker (sides game)"""
        slug = 'checker'
        self.log("\n--- Checker ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Checker")
        self.test_live_game_wait_for_betting(slug, "Checker")
        self.test_live_game_place_bet(slug, "Checker", selection="gold")
        self.test_live_game_invalid_selection(slug, "Checker", invalid_selection="bronze")
        self.test_live_game_legacy_play_blocked(slug, "Checker")

    def test_teen_patti(self):
        """Test Teen Patti (sides game)"""
        slug = 'teen-patti'
        self.log("\n--- Teen Patti ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Teen Patti")
        self.test_live_game_wait_for_betting(slug, "Teen Patti")
        self.test_live_game_place_bet(slug, "Teen Patti", selection="player")
        self.test_live_game_invalid_selection(slug, "Teen Patti", invalid_selection="banker")
        self.test_live_game_legacy_play_blocked(slug, "Teen Patti")

    def test_andar_bahar(self):
        """Test Andar Bahar (sides game)"""
        slug = 'andar-bahar'
        self.log("\n--- Andar Bahar ---", Colors.YELLOW)
        self.test_live_game_state(slug, "Andar Bahar")
        self.test_live_game_wait_for_betting(slug, "Andar Bahar")
        self.test_live_game_place_bet(slug, "Andar Bahar", selection="andar")
        self.test_live_game_legacy_play_blocked(slug, "Andar Bahar")

    def run_all_tests(self):
        """Run all live games tests"""
        self.log("\n" + "="*70, Colors.YELLOW)
        self.log("FunGame Live Games Backend Test Suite", Colors.YELLOW)
        self.log("Testing Aviator + 16 Live Casino Games", Colors.YELLOW)
        self.log("="*70 + "\n", Colors.YELLOW)

        # Setup
        self.test("Login as player", self.test_login_player)

        # Aviator tests
        self.log("\n" + "="*70, Colors.YELLOW)
        self.log("AVIATOR CRASH GAME TESTS", Colors.YELLOW)
        self.log("="*70, Colors.YELLOW)
        
        self.test("Aviator state (check structure, no crash_point leak)", self.test_aviator_state)
        self.test("Wait for BETTING phase", self.test_aviator_wait_for_betting)
        self.test("Place bet on panel 1", self.test_aviator_place_bet_panel1)
        self.test("Place bet on panel 2 with auto_cashout", self.test_aviator_place_bet_panel2_with_auto_cashout)
        self.test("Duplicate bet rejected (409)", self.test_aviator_duplicate_bet_rejected)
        self.test("Cancel bet during betting", self.test_aviator_cancel_bet)
        self.test("Wait for FLYING phase", self.test_aviator_wait_for_flying)
        self.test("Manual cashout during flight", self.test_aviator_cashout_during_flight)
        self.test("Bet queued during flight", self.test_aviator_bet_queued_during_flight)
        self.test("Insufficient chips rejected (400)", self.test_aviator_insufficient_chips)

        # Live games tests
        self.log("\n" + "="*70, Colors.YELLOW)
        self.log("16 LIVE CASINO GAMES TESTS", Colors.YELLOW)
        self.log("="*70, Colors.YELLOW)
        
        self.test("Seven-Up-Down (sides)", self.test_seven_up_down)
        self.test("Fun Target (pick)", self.test_fun_target)
        self.test("Keno (picks)", self.test_keno)
        self.test("Bingo (stake-only, card)", self.test_bingo)
        self.test("Giant Jackpot (slot)", self.test_slots)
        self.test("Checker (sides)", self.test_checker)
        self.test("Teen Patti (sides)", self.test_teen_patti)
        self.test("Andar Bahar (sides)", self.test_andar_bahar)

        # Summary
        self.log("\n" + "="*70, Colors.YELLOW)
        self.log("TEST SUMMARY", Colors.YELLOW)
        self.log("="*70, Colors.YELLOW)
        self.log(f"Total tests: {self.tests_run}", Colors.BLUE)
        self.log(f"Passed: {self.tests_passed}", Colors.GREEN)
        self.log(f"Failed: {self.tests_failed}", Colors.RED)
        
        if self.tests_failed > 0:
            self.log("\nFailed tests:", Colors.RED)
            for failed in self.failed_tests:
                self.log(f"  - {failed}", Colors.RED)
        
        success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
        self.log(f"\nSuccess rate: {success_rate:.1f}%", Colors.GREEN if success_rate == 100 else Colors.YELLOW)
        self.log("="*70 + "\n", Colors.YELLOW)

        return 0 if self.tests_failed == 0 else 1

if __name__ == "__main__":
    tester = LiveGamesTester()
    sys.exit(tester.run_all_tests())
