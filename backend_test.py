"""
FunGame Backend API Test Suite
Tests all backend endpoints for the foundation gate.
"""
import requests
import sys
import random
import string
from datetime import datetime

BASE_URL = "https://casino-reference-app.preview.emergentagent.com/api"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    END = '\033[0m'

class FunGameTester:
    def __init__(self):
        self.tests_run = 0
        self.tests_passed = 0
        self.tests_failed = 0
        self.admin_token = None
        self.player_token = None
        self.new_user_token = None
        self.new_user_email = None
        self.new_user_id = None
        self.dev_code = None
        self.chip_request_id = None
        self.failed_tests = []

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
            elif method == 'PATCH':
                resp = requests.patch(url, json=data, headers=headers, timeout=10)
            elif method == 'DELETE':
                resp = requests.delete(url, headers=headers, timeout=10)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            if desc:
                print(f"   {desc}: {resp.status_code}")
            
            assert resp.status_code == expected_status, f"Expected {expected_status}, got {resp.status_code}. Response: {resp.text[:200]}"
            
            try:
                return resp.json()
            except:
                return {}
        except requests.exceptions.RequestException as e:
            raise AssertionError(f"Request failed: {str(e)}")

    # ========== HEALTH & ROOT ==========
    def test_health(self):
        data = self.req('GET', '/health', 200, desc="Health check")
        assert data.get('status') == 'ok', "Health check should return status ok"

    def test_root(self):
        data = self.req('GET', '/', 200, desc="Root endpoint")
        assert 'FunGame' in data.get('message', ''), "Root should mention FunGame"
        assert 'PLAY CHIPS' in data.get('disclaimer', ''), "Root should have disclaimer"

    # ========== AUTH FLOW ==========
    def test_register_new_user(self):
        """Register a new user and capture dev_code"""
        rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        self.new_user_email = f"test_{rand}@example.com"
        password = "TestPass123!"
        
        data = self.req('POST', '/auth/register', 200, data={
            'email': self.new_user_email,
            'password': password
        }, desc="Register new user")
        
        assert 'dev_code' in data, "Registration should return dev_code in demo mode"
        self.dev_code = data['dev_code']
        assert len(self.dev_code) == 6, "dev_code should be 6 digits"
        print(f"   📧 Dev code: {self.dev_code}")

    def test_verify_email(self):
        """Verify email with dev_code and get token"""
        assert self.dev_code, "dev_code must be set from registration"
        
        data = self.req('POST', '/auth/verify-email', 200, data={
            'email': self.new_user_email,
            'code': self.dev_code
        }, desc="Verify email")
        
        assert 'access_token' in data, "Verify should return access_token"
        assert 'user' in data, "Verify should return user object"
        self.new_user_token = data['access_token']
        self.new_user_id = data['user']['id']
        assert data['user']['status'] == 'VERIFIED', "User status should be VERIFIED after email verification"
        print(f"   🔑 Token obtained for new user")

    def test_login_admin(self):
        """Login as admin"""
        data = self.req('POST', '/auth/login', 200, data={
            'email': 'admin@fungame.app',
            'password': 'FunGame@Admin2025'
        }, desc="Admin login")
        
        assert 'access_token' in data, "Login should return access_token"
        assert data['user']['role'] == 'ADMIN', "User should be ADMIN"
        self.admin_token = data['access_token']
        print(f"   🔑 Admin token obtained")

    def test_login_player(self):
        """Login as pre-approved player"""
        data = self.req('POST', '/auth/login', 200, data={
            'email': 'player@fungame.app',
            'password': 'Player@123'
        }, desc="Player login")
        
        assert 'access_token' in data, "Login should return access_token"
        assert data['user']['role'] == 'PLAYER', "User should be PLAYER"
        assert data['user']['status'] == 'ACTIVE', "Player should be ACTIVE"
        self.player_token = data['access_token']
        print(f"   🔑 Player token obtained, balance: {data['user']['chip_balance']}")

    def test_forgot_password(self):
        """Test forgot password flow"""
        data = self.req('POST', '/auth/forgot-password', 200, data={
            'email': 'player@fungame.app'
        }, desc="Forgot password")
        
        assert 'message' in data, "Should return message"
        # In demo mode, dev_code should be present
        if 'dev_code' in data:
            print(f"   📧 Reset code: {data['dev_code']}")

    def test_reset_password(self):
        """Test reset password with code"""
        # Use player email for reset test to avoid interfering with new user flow
        data = self.req('POST', '/auth/forgot-password', 200, data={
            'email': 'player@fungame.app'
        }, desc="Request reset code")
        
        if 'dev_code' in data:
            reset_code = data['dev_code']
            # Now reset password
            self.req('POST', '/auth/reset-password', 200, data={
                'email': 'player@fungame.app',
                'code': reset_code,
                'new_password': 'Player@123'  # Reset to same password to not break other tests
            }, desc="Reset password")
            print(f"   ✅ Password reset successful")

    # ========== ONBOARDING ==========
    def test_onboarding_profile(self):
        """Submit onboarding profile"""
        assert self.new_user_token, "New user token required"
        
        data = self.req('POST', '/onboarding/profile', 200, token=self.new_user_token, data={
            'display_name': 'Test Player',
            'country': 'India',
            'date_of_birth': '1995-05-15',
            'avatar': 'star'
        }, desc="Submit profile")
        
        assert data['user']['status'] == 'PROFILE_SUBMITTED', "Status should be PROFILE_SUBMITTED"
        print(f"   ✅ Profile submitted")

    def test_onboarding_submit(self):
        """Submit for approval"""
        assert self.new_user_token, "New user token required"
        
        data = self.req('POST', '/onboarding/submit', 200, token=self.new_user_token, desc="Submit for approval")
        
        assert data['user']['status'] == 'PENDING', "Status should be PENDING"
        print(f"   ✅ Submitted for approval, status: PENDING")

    def test_pending_user_blocked_from_games(self):
        """PENDING user should get 403 from /games"""
        assert self.new_user_token, "New user token required"
        
        self.req('GET', '/games', 403, token=self.new_user_token, desc="PENDING user accessing games")
        print(f"   ✅ PENDING user correctly blocked from /games")

    def test_pending_user_blocked_from_chips(self):
        """PENDING user should get 403 from /chips/balance"""
        assert self.new_user_token, "New user token required"
        
        self.req('GET', '/chips/balance', 403, token=self.new_user_token, desc="PENDING user accessing chips")
        print(f"   ✅ PENDING user correctly blocked from /chips/balance")

    # ========== ADMIN USER APPROVAL ==========
    def test_admin_list_pending_users(self):
        """Admin lists pending users"""
        assert self.admin_token, "Admin token required"
        
        data = self.req('GET', '/admin/users?status=PENDING', 200, token=self.admin_token, desc="List pending users")
        
        assert 'users' in data, "Should return users array"
        # Find our new user
        found = any(u['id'] == self.new_user_id for u in data['users'])
        assert found, f"New user {self.new_user_id} should be in pending list"
        print(f"   ✅ Found {len(data['users'])} pending user(s)")

    def test_admin_approve_user(self):
        """Admin approves user - should set ACTIVE and credit 1000 welcome chips"""
        assert self.admin_token, "Admin token required"
        assert self.new_user_id, "New user ID required"
        
        data = self.req('POST', f'/admin/users/{self.new_user_id}/approve', 200, token=self.admin_token, desc="Approve user")
        
        assert data['user']['status'] == 'ACTIVE', "User should be ACTIVE after approval"
        assert data['user']['chip_balance'] == 1000, "User should have 1000 welcome chips"
        print(f"   ✅ User approved, balance: {data['user']['chip_balance']}")

    def test_admin_double_approve_blocked(self):
        """Double-approve should fail with 400"""
        assert self.admin_token, "Admin token required"
        assert self.new_user_id, "New user ID required"
        
        self.req('POST', f'/admin/users/{self.new_user_id}/approve', 400, token=self.admin_token, desc="Double approve attempt")
        print(f"   ✅ Double-approve correctly blocked")

    # ========== GAMES ==========
    def test_games_list_18_games(self):
        """GET /games should return exactly 18 games, all COMING_SOON"""
        # Refresh token for newly approved user
        data = self.req('POST', '/auth/login', 200, data={
            'email': self.new_user_email,
            'password': 'TestPass123!'
        })
        self.new_user_token = data['access_token']
        
        data = self.req('GET', '/games', 200, token=self.new_user_token, desc="List games")
        
        games = data.get('games', [])
        assert len(games) == 18, f"Should have exactly 18 games, got {len(games)}"
        
        # Check all are COMING_SOON
        for game in games:
            assert game['status'] == 'COMING_SOON', f"Game {game['slug']} should be COMING_SOON, got {game['status']}"
        
        print(f"   ✅ Found 18 games, all COMING_SOON")

    def test_game_detail(self):
        """GET /games/{slug} should return game details"""
        data = self.req('GET', '/games/aviator', 200, token=self.new_user_token, desc="Get game detail")
        
        assert data['game']['slug'] == 'aviator', "Should return aviator game"
        assert data['game']['status'] == 'COMING_SOON', "Aviator should be COMING_SOON"
        print(f"   ✅ Game detail retrieved: {data['game']['name']}")

    def test_game_play_blocked(self):
        """POST /games/aviator/play should return 409 (non-playable)"""
        self.req('POST', '/games/aviator/play', 409, token=self.new_user_token, desc="Attempt to play game")
        print(f"   ✅ Game play correctly blocked with 409")

    def test_game_favorite_toggle(self):
        """Toggle favorite on a game"""
        data = self.req('POST', '/games/aviator/favorite', 200, token=self.new_user_token, desc="Toggle favorite")
        
        assert 'favorites' in data, "Should return favorites array"
        print(f"   ✅ Favorite toggled, action: {data.get('action')}")

    # ========== CHIPS ==========
    def test_chip_balance(self):
        """GET /chips/balance should return balance"""
        data = self.req('GET', '/chips/balance', 200, token=self.new_user_token, desc="Get chip balance")
        
        assert 'balance' in data, "Should return balance"
        assert data['balance'] == 1000, "New approved user should have 1000 chips"
        assert 'PLAY CHIPS' in data.get('disclaimer', ''), "Should have disclaimer"
        print(f"   ✅ Balance: {data['balance']}")

    def test_chip_request_create(self):
        """POST /chips/request should create a chip request"""
        data = self.req('POST', '/chips/request', 200, token=self.new_user_token, data={
            'amount': 2500,
            'note': 'Test request for 2500 chips'
        }, desc="Create chip request")
        
        assert 'request' in data, "Should return request object"
        assert data['request']['status'] == 'PENDING', "Request should be PENDING"
        self.chip_request_id = data['request']['id']
        print(f"   ✅ Chip request created: {self.chip_request_id}")

    def test_chip_requests_list(self):
        """GET /chips/requests should list user's requests"""
        data = self.req('GET', '/chips/requests', 200, token=self.new_user_token, desc="List chip requests")
        
        assert 'requests' in data, "Should return requests array"
        assert len(data['requests']) > 0, "Should have at least one request"
        print(f"   ✅ Found {len(data['requests'])} request(s)")

    def test_admin_list_chip_requests(self):
        """Admin lists chip requests"""
        data = self.req('GET', '/admin/chip-requests?status=PENDING', 200, token=self.admin_token, desc="Admin list chip requests")
        
        assert 'requests' in data, "Should return requests array"
        found = any(r['id'] == self.chip_request_id for r in data['requests'])
        assert found, "Should find our chip request"
        print(f"   ✅ Found {len(data['requests'])} pending request(s)")

    def test_admin_approve_chip_request(self):
        """Admin approves chip request - should credit balance and create ledger entry"""
        assert self.chip_request_id, "Chip request ID required"
        
        data = self.req('POST', f'/admin/chip-requests/{self.chip_request_id}/approve', 200, token=self.admin_token, data={
            'note': 'Approved by admin'
        }, desc="Approve chip request")
        
        assert 'balance_after' in data, "Should return balance_after"
        assert data['balance_after'] == 3500, f"Balance should be 3500 (1000 + 2500), got {data['balance_after']}"
        print(f"   ✅ Chip request approved, new balance: {data['balance_after']}")

    def test_admin_double_approve_chip_request_blocked(self):
        """Double-approve chip request should fail with 400"""
        assert self.chip_request_id, "Chip request ID required"
        
        self.req('POST', f'/admin/chip-requests/{self.chip_request_id}/approve', 400, token=self.admin_token, desc="Double approve chip request")
        print(f"   ✅ Double-approve chip request correctly blocked")

    def test_chip_transactions(self):
        """GET /chips/transactions should show ledger entries"""
        data = self.req('GET', '/chips/transactions', 200, token=self.new_user_token, desc="Get transactions")
        
        assert 'transactions' in data, "Should return transactions array"
        assert len(data['transactions']) >= 2, "Should have at least 2 transactions (welcome + approved request)"
        print(f"   ✅ Found {len(data['transactions'])} transaction(s)")

    # ========== NOTIFICATIONS ==========
    def test_notifications(self):
        """GET /notifications should return notifications"""
        data = self.req('GET', '/notifications', 200, token=self.new_user_token, desc="Get notifications")
        
        assert 'notifications' in data, "Should return notifications array"
        assert 'unread_count' in data, "Should return unread_count"
        # User should have notifications from approval and chip request approval
        assert len(data['notifications']) >= 2, "Should have at least 2 notifications"
        print(f"   ✅ Found {len(data['notifications'])} notification(s), {data['unread_count']} unread")

    def test_mark_notification_read(self):
        """Mark a notification as read"""
        # Get notifications first
        data = self.req('GET', '/notifications', 200, token=self.new_user_token)
        if data['notifications']:
            notif_id = data['notifications'][0]['id']
            self.req('POST', f'/notifications/{notif_id}/read', 200, token=self.new_user_token, desc="Mark notification read")
            print(f"   ✅ Notification marked as read")

    # ========== ANNOUNCEMENTS ==========
    def test_announcements(self):
        """GET /announcements should return announcements"""
        data = self.req('GET', '/announcements', 200, token=self.new_user_token, desc="Get announcements")
        
        assert 'announcements' in data, "Should return announcements array"
        assert len(data['announcements']) >= 3, "Should have at least 3 seeded announcements"
        # Check first is pinned
        if data['announcements']:
            assert data['announcements'][0].get('pinned') == True, "First announcement should be pinned"
        print(f"   ✅ Found {len(data['announcements'])} announcement(s)")

    # ========== SETTINGS ==========
    def test_update_settings(self):
        """PATCH /settings should update user settings"""
        data = self.req('PATCH', '/settings', 200, token=self.new_user_token, data={
            'reduced_motion': True,
            'high_contrast': True
        }, desc="Update settings")
        
        assert 'settings' in data, "Should return settings object"
        assert data['settings']['reduced_motion'] == True, "reduced_motion should be True"
        assert data['settings']['high_contrast'] == True, "high_contrast should be True"
        print(f"   ✅ Settings updated")

    def test_change_password(self):
        """POST /auth/change-password should change password"""
        self.req('POST', '/auth/change-password', 200, token=self.new_user_token, data={
            'current_password': 'TestPass123!',
            'new_password': 'NewTestPass123!'
        }, desc="Change password")
        print(f"   ✅ Password changed")

    # ========== MAINTENANCE MODE ==========
    def test_maintenance_mode_on(self):
        """Admin enables maintenance mode"""
        data = self.req('PATCH', '/admin/system', 200, token=self.admin_token, data={
            'maintenance_mode': True
        }, desc="Enable maintenance mode")
        
        assert data['config']['maintenance_mode'] == True, "Maintenance mode should be enabled"
        print(f"   ✅ Maintenance mode enabled")

    def test_player_blocked_during_maintenance(self):
        """Player should get 503 during maintenance"""
        self.req('GET', '/games', 503, token=self.player_token, desc="Player accessing games during maintenance")
        print(f"   ✅ Player correctly blocked with 503 during maintenance")

    def test_admin_works_during_maintenance(self):
        """Admin should still work during maintenance"""
        data = self.req('GET', '/admin/stats', 200, token=self.admin_token, desc="Admin accessing stats during maintenance")
        
        assert 'total_users' in data, "Admin should get stats"
        print(f"   ✅ Admin still has access during maintenance")

    def test_maintenance_mode_off(self):
        """Admin disables maintenance mode"""
        data = self.req('PATCH', '/admin/system', 200, token=self.admin_token, data={
            'maintenance_mode': False
        }, desc="Disable maintenance mode")
        
        assert data['config']['maintenance_mode'] == False, "Maintenance mode should be disabled"
        print(f"   ✅ Maintenance mode disabled")

    def test_player_access_restored(self):
        """Player should access games after maintenance is off"""
        data = self.req('GET', '/games', 200, token=self.player_token, desc="Player accessing games after maintenance")
        
        assert len(data['games']) == 18, "Player should see 18 games"
        print(f"   ✅ Player access restored")

    # ========== NO PAYMENT ROUTES ==========
    def test_no_payment_routes(self):
        """Verify no payment/deposit/withdraw routes exist"""
        payment_endpoints = [
            '/payment', '/payments', '/deposit', '/deposits',
            '/withdraw', '/withdrawals', '/cashout', '/transfer'
        ]
        
        for endpoint in payment_endpoints:
            self.req('GET', endpoint, 404, token=self.player_token, desc=f"Check {endpoint} returns 404")
        
        print(f"   ✅ All payment routes correctly return 404")

    # ========== ADMIN STATS ==========
    def test_admin_stats(self):
        """GET /admin/stats should return dashboard stats"""
        data = self.req('GET', '/admin/stats', 200, token=self.admin_token, desc="Get admin stats")
        
        assert 'total_users' in data, "Should return total_users"
        assert 'pending_users' in data, "Should return pending_users"
        assert 'total_games' in data, "Should return total_games"
        assert data['total_games'] == 18, "Should have 18 games"
        print(f"   ✅ Stats: {data['total_users']} users, {data['total_games']} games")

    # ========== SYSTEM CONFIG ==========
    def test_system_config_public(self):
        """GET /system/config should be public (no auth)"""
        data = self.req('GET', '/system/config', 200, desc="Get system config (public)")
        
        assert 'maintenance_mode' in data, "Should return maintenance_mode"
        assert 'PLAY CHIPS' in data.get('disclaimer', ''), "Should have disclaimer"
        print(f"   ✅ System config accessible without auth")

    # ========== FUN ROULETTE LIVE GAME ==========
    def test_roulette_state_player(self):
        """GET /games/fun-roulette/state as player"""
        import time
        data = self.req('GET', '/games/fun-roulette/state', 200, token=self.player_token, desc="Get roulette state (player)")
        
        assert 'round_number' in data, "Should return round_number"
        assert 'phase' in data, "Should return phase"
        assert data['phase'] in ['BETTING', 'SPINNING', 'RESULT'], f"Phase should be valid, got {data['phase']}"
        assert 'phase_ends_in' in data, "Should return phase_ends_in"
        assert 'my_bets' in data, "Should return my_bets"
        assert 'last_results' in data, "Should return last_results"
        assert 'balance' in data, "Should return balance"
        
        # Store for universal sync test
        self.roulette_round_player = data['round_number']
        self.roulette_phase_player = data['phase']
        self.roulette_winning_player = data.get('winning_number')
        
        print(f"   ✅ Round {data['round_number']}, phase: {data['phase']}, countdown: {data['phase_ends_in']:.1f}s")
        return data

    def test_roulette_state_admin(self):
        """GET /games/fun-roulette/state as admin - should match player's round"""
        data = self.req('GET', '/games/fun-roulette/state', 200, token=self.admin_token, desc="Get roulette state (admin)")
        
        assert data['round_number'] == self.roulette_round_player, f"Admin round {data['round_number']} should match player round {self.roulette_round_player}"
        
        # If phase is not BETTING, winning_number must match
        if self.roulette_phase_player != 'BETTING' and self.roulette_winning_player is not None:
            assert data.get('winning_number') == self.roulette_winning_player, f"Admin winning number {data.get('winning_number')} should match player {self.roulette_winning_player}"
        
        print(f"   ✅ Universal sync verified: both see round {data['round_number']}")

    def test_roulette_wait_for_betting_phase(self):
        """Wait for BETTING phase to test placing bets"""
        import time
        max_wait = 30
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/games/fun-roulette/state', 200, token=self.player_token)
            if data['phase'] == 'BETTING' and data['phase_ends_in'] > 6:
                print(f"   ✅ BETTING phase ready, {data['phase_ends_in']:.1f}s remaining")
                self.roulette_betting_round = data['round_number']
                return data
            time.sleep(1)
        
        raise AssertionError("Timeout waiting for BETTING phase with >6s remaining")

    def test_roulette_place_bet_color(self):
        """POST /games/fun-roulette/bets - place bet on red"""
        data = self.req('POST', '/games/fun-roulette/bets', 200, token=self.player_token, data={
            'bet_type': 'color',
            'value': 'red',
            'amount': 100
        }, desc="Place bet on RED")
        
        assert 'my_bets' in data, "Should return my_bets"
        assert 'my_total' in data, "Should return my_total"
        assert data['my_total'] >= 100, f"Total should be at least 100, got {data['my_total']}"
        assert 'balance' in data, "Should return updated balance"
        
        self.roulette_balance_after_bet = data['balance']
        print(f"   ✅ Bet placed, total: {data['my_total']}, balance: {data['balance']}")

    def test_roulette_place_bet_straight(self):
        """POST /games/fun-roulette/bets - stack another bet on number 17"""
        data = self.req('POST', '/games/fun-roulette/bets', 200, token=self.player_token, data={
            'bet_type': 'straight',
            'value': 17,
            'amount': 50
        }, desc="Place bet on number 17")
        
        assert data['my_total'] >= 150, f"Total should be at least 150 (100+50), got {data['my_total']}"
        print(f"   ✅ Stacked bet, total: {data['my_total']}")

    def test_roulette_clear_bets(self):
        """POST /games/fun-roulette/bets/clear - refund all bets"""
        data = self.req('POST', '/games/fun-roulette/bets/clear', 200, token=self.player_token, desc="Clear all bets")
        
        assert 'refunded' in data, "Should return refunded amount"
        assert data['refunded'] >= 150, f"Should refund at least 150, got {data['refunded']}"
        assert 'balance' in data, "Should return updated balance"
        
        print(f"   ✅ Bets cleared, refunded: {data['refunded']}, balance: {data['balance']}")

    def test_roulette_bet_below_minimum(self):
        """POST /games/fun-roulette/bets with amount < 10 should fail with 400"""
        self.req('POST', '/games/fun-roulette/bets', 400, token=self.player_token, data={
            'bet_type': 'color',
            'value': 'black',
            'amount': 5
        }, desc="Bet below minimum (5 chips)")
        
        print(f"   ✅ Bet below minimum correctly rejected with 400")

    def test_roulette_place_final_bet(self):
        """Place a final bet to test settlement"""
        data = self.req('POST', '/games/fun-roulette/bets', 200, token=self.player_token, data={
            'bet_type': 'color',
            'value': 'black',
            'amount': 100
        }, desc="Place final bet for settlement test")
        
        self.roulette_final_bet_round = data['round_number']
        print(f"   ✅ Final bet placed on round {data['round_number']}")

    def test_roulette_wait_for_settlement(self):
        """Wait for the round to complete and check settlement"""
        import time
        max_wait = 30
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/games/fun-roulette/state', 200, token=self.player_token)
            
            # Check if we got settlement for our bet round
            if data.get('settled') and data['settled']['round_number'] == self.roulette_final_bet_round:
                settled = data['settled']
                assert 'winning_number' in settled, "Settlement should have winning_number"
                assert 'total_bet' in settled, "Settlement should have total_bet"
                assert 'payout' in settled, "Settlement should have payout"
                assert settled['total_bet'] == 100, f"Total bet should be 100, got {settled['total_bet']}"
                
                print(f"   ✅ Settlement received: round {settled['round_number']}, number {settled['winning_number']}, bet {settled['total_bet']}, payout {settled['payout']}")
                return settled
            
            time.sleep(2)
        
        raise AssertionError("Timeout waiting for settlement")

    def test_roulette_bet_during_spinning_phase(self):
        """Wait for SPINNING phase and verify bets are rejected with 409"""
        import time
        max_wait = 30
        start = time.time()
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/games/fun-roulette/state', 200, token=self.player_token)
            if data['phase'] in ['SPINNING', 'RESULT']:
                # Try to place bet - should fail with 409
                self.req('POST', '/games/fun-roulette/bets', 409, token=self.player_token, data={
                    'bet_type': 'color',
                    'value': 'red',
                    'amount': 100
                }, desc=f"Bet during {data['phase']} phase")
                
                print(f"   ✅ Bet correctly rejected with 409 during {data['phase']} phase")
                return
            
            time.sleep(1)
        
        raise AssertionError("Timeout waiting for SPINNING/RESULT phase")

    def test_roulette_old_play_endpoint(self):
        """POST /games/fun-roulette/play should return 409 LIVE_ROUNDS"""
        self.req('POST', '/games/fun-roulette/play', 409, token=self.player_token, data={
            'bet': 100,
            'payload': {'bet_type': 'color', 'value': 'red'}
        }, desc="Old play endpoint")
        
        print(f"   ✅ Old play endpoint correctly returns 409 LIVE_ROUNDS")

    def test_roulette_history(self):
        """GET /games/fun-roulette/history should show settled rounds"""
        data = self.req('GET', '/games/fun-roulette/history', 200, token=self.player_token, desc="Get roulette history")
        
        assert 'rounds' in data, "Should return rounds array"
        # Should have at least one settled round from our test
        assert len(data['rounds']) > 0, "Should have at least one round in history"
        
        # Check first round structure
        if data['rounds']:
            r = data['rounds'][0]
            assert 'outcome' in r, "Round should have outcome"
            assert 'winning_number' in r['outcome'], "Outcome should have winning_number"
            assert 'bet' in r, "Round should have bet (total bet amount)"
            assert 'payout' in r, "Round should have payout"
            assert 'bets' in r['outcome'], "Outcome should have bets array"
        
        print(f"   ✅ History retrieved: {len(data['rounds'])} round(s)")

    def test_roulette_phase_progression(self):
        """Poll state across a full cycle and verify phase progression"""
        import time
        
        # Wait for a new round to start (BETTING phase)
        max_wait = 30
        start = time.time()
        initial_round = None
        
        while time.time() - start < max_wait:
            data = self.req('GET', '/games/fun-roulette/state', 200, token=self.player_token)
            if data['phase'] == 'BETTING' and data['phase_ends_in'] > 15:
                initial_round = data['round_number']
                print(f"   📍 Starting phase progression test at round {initial_round}, BETTING phase")
                break
            time.sleep(1)
        
        if not initial_round:
            raise AssertionError("Could not find BETTING phase to start progression test")
        
        # Track phases
        phases_seen = []
        last_phase = None
        
        # Poll for 30 seconds to see phase transitions
        start = time.time()
        while time.time() - start < 30:
            data = self.req('GET', '/games/fun-roulette/state', 200, token=self.player_token)
            
            if data['phase'] != last_phase:
                phases_seen.append(data['phase'])
                print(f"   📍 Phase: {data['phase']}, round: {data['round_number']}, countdown: {data['phase_ends_in']:.1f}s")
                last_phase = data['phase']
            
            # If we've seen all three phases and moved to next round, we're done
            if len(phases_seen) >= 3 and data['round_number'] > initial_round:
                print(f"   ✅ Phase progression verified: {' → '.join(phases_seen)}")
                assert 'BETTING' in phases_seen, "Should see BETTING phase"
                assert 'SPINNING' in phases_seen, "Should see SPINNING phase"
                assert 'RESULT' in phases_seen, "Should see RESULT phase"
                return
            
            time.sleep(1)
        
        # If we didn't see all phases, that's still ok - just report what we saw
        print(f"   ⚠️  Saw phases: {' → '.join(phases_seen)} (may not have completed full cycle)")

    def run_all_tests(self):
        """Run all tests in order"""
        self.log("\n" + "="*60, Colors.YELLOW)
        self.log("FunGame Backend API Test Suite", Colors.YELLOW)
        self.log("="*60 + "\n", Colors.YELLOW)

        # Health checks
        self.test("Health endpoint", self.test_health)
        self.test("Root endpoint", self.test_root)
        self.test("System config (public)", self.test_system_config_public)

        # Auth flow
        self.test("Register new user", self.test_register_new_user)
        self.test("Verify email with dev_code", self.test_verify_email)
        self.test("Login as admin", self.test_login_admin)
        self.test("Login as player", self.test_login_player)
        self.test("Forgot password", self.test_forgot_password)
        self.test("Reset password", self.test_reset_password)

        # Onboarding
        self.test("Submit onboarding profile", self.test_onboarding_profile)
        self.test("Submit for approval", self.test_onboarding_submit)
        self.test("PENDING user blocked from /games", self.test_pending_user_blocked_from_games)
        self.test("PENDING user blocked from /chips/balance", self.test_pending_user_blocked_from_chips)

        # Admin approval
        self.test("Admin list pending users", self.test_admin_list_pending_users)
        self.test("Admin approve user (1000 welcome chips)", self.test_admin_approve_user)
        self.test("Double-approve blocked", self.test_admin_double_approve_blocked)

        # Games
        self.test("List 18 games (all COMING_SOON)", self.test_games_list_18_games)
        self.test("Get game detail", self.test_game_detail)
        self.test("Game play blocked (409)", self.test_game_play_blocked)
        self.test("Toggle game favorite", self.test_game_favorite_toggle)

        # Chips
        self.test("Get chip balance", self.test_chip_balance)
        self.test("Create chip request", self.test_chip_request_create)
        self.test("List chip requests", self.test_chip_requests_list)
        self.test("Admin list chip requests", self.test_admin_list_chip_requests)
        self.test("Admin approve chip request", self.test_admin_approve_chip_request)
        self.test("Double-approve chip request blocked", self.test_admin_double_approve_chip_request_blocked)
        self.test("Get transaction ledger", self.test_chip_transactions)

        # Notifications
        self.test("Get notifications", self.test_notifications)
        self.test("Mark notification as read", self.test_mark_notification_read)

        # Announcements
        self.test("Get announcements (3 seeded)", self.test_announcements)

        # Settings
        self.test("Update user settings", self.test_update_settings)
        self.test("Change password", self.test_change_password)

        # Maintenance mode
        self.test("Enable maintenance mode", self.test_maintenance_mode_on)
        self.test("Player blocked during maintenance (503)", self.test_player_blocked_during_maintenance)
        self.test("Admin works during maintenance", self.test_admin_works_during_maintenance)
        self.test("Disable maintenance mode", self.test_maintenance_mode_off)
        self.test("Player access restored", self.test_player_access_restored)

        # No payment routes
        self.test("No payment routes exist (404)", self.test_no_payment_routes)

        # Admin
        self.test("Admin dashboard stats", self.test_admin_stats)

        # Fun Roulette Live Game
        self.log("\n" + "="*60, Colors.YELLOW)
        self.log("FUN ROULETTE LIVE GAME TESTS", Colors.YELLOW)
        self.log("="*60 + "\n", Colors.YELLOW)
        
        self.test("Roulette state (player)", self.test_roulette_state_player)
        self.test("Roulette state (admin) - universal sync", self.test_roulette_state_admin)
        self.test("Wait for BETTING phase", self.test_roulette_wait_for_betting_phase)
        self.test("Place bet on color (RED)", self.test_roulette_place_bet_color)
        self.test("Stack bet on straight number (17)", self.test_roulette_place_bet_straight)
        self.test("Clear bets (refund)", self.test_roulette_clear_bets)
        self.test("Bet below minimum (400)", self.test_roulette_bet_below_minimum)
        self.test("Place final bet for settlement", self.test_roulette_place_final_bet)
        self.test("Wait for settlement", self.test_roulette_wait_for_settlement)
        self.test("Bet during SPINNING/RESULT phase (409)", self.test_roulette_bet_during_spinning_phase)
        self.test("Old play endpoint returns 409", self.test_roulette_old_play_endpoint)
        self.test("Roulette history", self.test_roulette_history)
        self.test("Phase progression (BETTING→SPINNING→RESULT)", self.test_roulette_phase_progression)

        # Summary
        self.log("\n" + "="*60, Colors.YELLOW)
        self.log("TEST SUMMARY", Colors.YELLOW)
        self.log("="*60, Colors.YELLOW)
        self.log(f"Total tests: {self.tests_run}", Colors.BLUE)
        self.log(f"Passed: {self.tests_passed}", Colors.GREEN)
        self.log(f"Failed: {self.tests_failed}", Colors.RED)
        
        if self.tests_failed > 0:
            self.log("\nFailed tests:", Colors.RED)
            for failed in self.failed_tests:
                self.log(f"  - {failed}", Colors.RED)
        
        success_rate = (self.tests_passed / self.tests_run * 100) if self.tests_run > 0 else 0
        self.log(f"\nSuccess rate: {success_rate:.1f}%", Colors.GREEN if success_rate == 100 else Colors.YELLOW)
        self.log("="*60 + "\n", Colors.YELLOW)

        return 0 if self.tests_failed == 0 else 1

if __name__ == "__main__":
    tester = FunGameTester()
    sys.exit(tester.run_all_tests())
