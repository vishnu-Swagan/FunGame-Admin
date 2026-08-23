"""Pydantic request/response models for Chakri.Casino API."""
import re
from pydantic import BaseModel, ConfigDict, Field, EmailStr, field_validator, model_validator
from typing import Optional, List
from avatar_service import PLAYER_AVATAR_KEYS


# ---------- Auth ----------
def _consistent_identity_values(*values):
    supplied = [str(value).strip() for value in values if value is not None]
    if not supplied:
        raise ValueError('Provide an email address or E.164 phone number')
    normalized = {re.sub(r'[\s().-]+', '', value).casefold() for value in supplied}
    if len(normalized) != 1:
        raise ValueError('Identity fields must refer to the same email address or phone number')


def _bcrypt_password_size(value):
    """Reject passwords bcrypt cannot represent without truncation."""
    if value is not None and len(str(value).encode('utf-8')) > 72:
        raise ValueError('Password must not exceed 72 UTF-8 bytes')
    return value


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    # The public form always collects both contact methods.  They remain
    # unverified while registration is in ADMIN_REVIEW mode; the optional
    # password fields preserve the existing PHONE_OTP flow, where the password
    # is deliberately created only after OTP proof.
    identity: Optional[str] = Field(default=None, min_length=3, max_length=254)
    identifier: Optional[str] = Field(default=None, min_length=3, max_length=254)
    email: Optional[EmailStr] = None
    phone: str = Field(min_length=8, max_length=20)
    channel: Optional[str] = Field(default='PHONE')
    full_name: Optional[str] = Field(default=None, min_length=2, max_length=64)
    date_of_birth: Optional[str] = None
    country: Optional[str] = Field(default=None, max_length=64)
    # Registration collects the full activation profile before issuing an SMS
    # challenge, so terms and eligibility cannot be deferred until after OTP.
    accepted_terms: bool = False
    password: Optional[str] = Field(default=None, min_length=8, max_length=128)
    password_confirmation: Optional[str] = Field(default=None, min_length=8, max_length=128)

    _password_bytes = field_validator(
        'password', 'password_confirmation',
    )(_bcrypt_password_size)

    @model_validator(mode='after')
    def phone_is_registration_identity(self):
        phone = re.sub(r'[\s().-]+', '', self.phone)
        supplied_identity = [
            str(value).strip() for value in (self.identifier, self.identity)
            if value is not None
        ]
        if any(re.sub(r'[\s().-]+', '', value) != phone for value in supplied_identity):
            raise ValueError('Registration identity must match the supplied phone number')
        if self.channel is not None and self.channel.upper() not in ('PHONE', 'SMS'):
            raise ValueError('Registration identity must be the supplied phone number')
        if ((self.password is None) != (self.password_confirmation is None)):
            raise ValueError('Password and confirmation must both be supplied')
        if self.password is not None and self.password != self.password_confirmation:
            raise ValueError('Password confirmation does not match')
        return self

    @field_validator('phone')
    @classmethod
    def register_phone_e164(cls, value):
        if value is None:
            return None
        cleaned = re.sub(r'[\s().-]+', '', value)
        if not re.fullmatch(r'\+[1-9]\d{7,14}', cleaned):
            raise ValueError('Phone must use E.164 format, e.g. +14155552671')
        return cleaned


class SignupRequestCreate(BaseModel):
    """Public account request - admin verifies and assigns Login ID + password."""
    full_name: str = Field(min_length=2, max_length=64)
    email: EmailStr
    date_of_birth: str  # YYYY-MM-DD
    phone: str = Field(min_length=7, max_length=20)
    # Optional so an older client that does not send it still works. An unstated
    # country reads as UNKNOWN, which only refuses anything once the operator
    # has switched an allow-list on.
    country: Optional[str] = Field(default=None, max_length=64)
    # Optional, and deliberately not validated here: an unknown code must not
    # cost the operator the registration. It is carried through and resolved at
    # approval, falling back to the house account.
    referral_code: Optional[str] = Field(default=None, max_length=16)

    @field_validator('phone')
    @classmethod
    def phone_with_country_code(cls, v):
        cleaned = v.strip().replace(' ', '').replace('-', '')
        if not re.fullmatch(r'\+[1-9]\d{7,14}', cleaned):
            raise ValueError('Phone must include country code, e.g. +14155552671')
        return cleaned

    @field_validator('date_of_birth')
    @classmethod
    def valid_dob(cls, v):
        from datetime import date
        try:
            d = date.fromisoformat(v.strip())
        except ValueError:
            raise ValueError('Date of birth must be YYYY-MM-DD')
        if d.year < 1900 or d >= date.today():
            raise ValueError('Invalid date of birth')
        return v.strip()


class AdminSignupApprove(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=8, max_length=128)
    starting_chips: int = Field(default=1000, ge=0, le=1_000_000)
    note: Optional[str] = Field(default=None, max_length=280)

    _password_bytes = field_validator('password')(_bcrypt_password_size)

    @field_validator('username')
    @classmethod
    def valid_username(cls, v):
        v = v.strip().lower()
        if not re.fullmatch(r'[a-z0-9][a-z0-9._]{2,23}', v):
            raise ValueError('Username must be 3-24 chars: letters, numbers, dot or underscore')
        return v


class AdminCreateUser(BaseModel):
    """Admin provisions an account directly (no signup request). The Login ID
    (GK + 7 digits) and password (7 capital letters) are issued by the server."""
    full_name: str = Field(min_length=1, max_length=80)
    starting_chips: int = Field(default=1000, ge=0, le=1_000_000)
    email: Optional[str] = Field(default=None, max_length=254)
    note: Optional[str] = Field(default=None, max_length=280)

    @field_validator('email')
    @classmethod
    def norm_email(cls, v):
        if v is None:
            return None
        v = v.strip().lower()
        return v or None


class VerifyEmailRequest(BaseModel):
    identity: Optional[str] = Field(default=None, min_length=3, max_length=254)
    identifier: Optional[str] = Field(default=None, min_length=3, max_length=254)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, min_length=8, max_length=20)
    channel: Optional[str] = None
    challenge_id: Optional[str] = Field(default=None, min_length=32, max_length=64)
    verification_id: Optional[str] = Field(default=None, min_length=32, max_length=64)
    code: str = Field(pattern=r'^\d{6}$')
    # Contact ownership and the chosen password are committed together. The
    # password supplied before OTP proof is deliberately never persisted.
    password: str = Field(min_length=8, max_length=128)

    _password_bytes = field_validator('password')(_bcrypt_password_size)

    @model_validator(mode='after')
    def verification_identity(self):
        _consistent_identity_values(self.identifier, self.identity, self.email, self.phone)
        return self


class ResendVerificationRequest(BaseModel):
    identity: Optional[str] = Field(default=None, min_length=3, max_length=254)
    identifier: Optional[str] = Field(default=None, min_length=3, max_length=254)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, min_length=8, max_length=20)
    channel: Optional[str] = None
    verification_id: Optional[str] = Field(default=None, min_length=32, max_length=64)

    @model_validator(mode='after')
    def resend_identity(self):
        _consistent_identity_values(self.identifier, self.identity, self.email, self.phone)
        return self


class LoginRequest(BaseModel):
    # ``email`` is the legacy Login ID/email field and intentionally remains a
    # plain string because it also carries GK usernames.
    identity: Optional[str] = Field(default=None, min_length=3, max_length=254)
    identifier: Optional[str] = Field(default=None, min_length=3, max_length=254)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, min_length=8, max_length=20)
    password: str = Field(min_length=1, max_length=128)

    _password_bytes = field_validator('password')(_bcrypt_password_size)

    @model_validator(mode='after')
    def login_identity(self):
        _consistent_identity_values(self.identifier, self.identity, self.email, self.phone)
        return self


class ForgotPasswordRequest(BaseModel):
    identity: Optional[str] = Field(default=None, min_length=3, max_length=254)
    identifier: Optional[str] = Field(default=None, min_length=3, max_length=254)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, min_length=8, max_length=20)

    @model_validator(mode='after')
    def forgot_identity(self):
        _consistent_identity_values(self.identifier, self.identity, self.email, self.phone)
        return self


class ResetPasswordRequest(BaseModel):
    identity: Optional[str] = Field(default=None, min_length=3, max_length=254)
    identifier: Optional[str] = Field(default=None, min_length=3, max_length=254)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, min_length=8, max_length=20)
    challenge_id: Optional[str] = Field(default=None, min_length=32, max_length=64)
    verification_id: Optional[str] = Field(default=None, min_length=32, max_length=64)
    code: str = Field(pattern=r'^\d{6}$')
    new_password: str = Field(min_length=8, max_length=128)

    _password_bytes = field_validator('new_password')(_bcrypt_password_size)

    @model_validator(mode='after')
    def reset_identity(self):
        _consistent_identity_values(self.identifier, self.identity, self.email, self.phone)
        return self


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

    _password_bytes = field_validator('current_password', 'new_password')(_bcrypt_password_size)


# ---------- Onboarding ----------
class OnboardingProfileRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=32)
    country: str = Field(min_length=2, max_length=64)
    date_of_birth: Optional[str] = None  # YYYY-MM-DD
    avatar: str = Field(default="star")  # preset avatar key
    accepted_terms: bool = False

    @field_validator('accepted_terms')
    @classmethod
    def must_accept(cls, v):
        if not v:
            raise ValueError('You must accept the terms to continue')
        return v

    @field_validator('avatar')
    @classmethod
    def known_avatar(cls, value):
        if value not in PLAYER_AVATAR_KEYS:
            raise ValueError('Unknown avatar')
        return value


class PlayerProfileUpdate(BaseModel):
    """Narrow public game-profile edit; contact and compliance data stay fixed."""
    model_config = ConfigDict(extra='forbid')

    display_name: Optional[str] = Field(default=None, min_length=2, max_length=32)
    avatar: Optional[str] = Field(default=None, min_length=2, max_length=24)

    @field_validator('display_name')
    @classmethod
    def clean_display_name(cls, value):
        if value is None:
            return None
        cleaned = value.strip()
        if len(cleaned) < 2:
            raise ValueError('Display name must contain at least 2 characters')
        return cleaned

    @field_validator('avatar')
    @classmethod
    def known_avatar(cls, value):
        if value is not None and value not in PLAYER_AVATAR_KEYS:
            raise ValueError('Unknown avatar')
        return value

    @model_validator(mode='after')
    def at_least_one_profile_field(self):
        if self.display_name is None and self.avatar is None:
            raise ValueError('Provide a display name or avatar')
        return self


class PlayerAvatarSelection(BaseModel):
    """Choose one public preset; uploaded images use the multipart endpoint."""
    model_config = ConfigDict(extra='forbid')

    avatar: str = Field(min_length=2, max_length=24)

    @field_validator('avatar')
    @classmethod
    def known_avatar(cls, value):
        if value not in PLAYER_AVATAR_KEYS:
            raise ValueError('Unknown avatar')
        return value


# ---------- Chips / Points ----------
class ChipRequestCreate(BaseModel):
    amount: int = Field(gt=0, le=1_000_000)
    note: Optional[str] = Field(default=None, max_length=280)


class SellChipsRequestCreate(BaseModel):
    """Player asks the operator to sell chips for points (1 chip = 1 point, min 500).
    Chips are deducted only when the admin approves the request."""
    amount: int = Field(ge=500, le=1_000_000)
    note: Optional[str] = Field(default=None, max_length=280)


class ConvertRequest(BaseModel):
    """Instant chips <-> points conversion (1 chip = 1 point, minimum 500)."""
    direction: str  # CHIPS_TO_POINTS | POINTS_TO_CHIPS
    amount: int = Field(ge=500, le=1_000_000)

    @field_validator('direction')
    @classmethod
    def valid_direction(cls, v):
        if v not in ('CHIPS_TO_POINTS', 'POINTS_TO_CHIPS'):
            raise ValueError('Invalid conversion direction')
        return v


class AdminPointsAdjust(BaseModel):
    delta: int = Field(ge=-1_000_000, le=1_000_000)
    note: Optional[str] = Field(default=None, max_length=280)

    @field_validator('delta')
    @classmethod
    def nonzero(cls, v):
        if v == 0:
            raise ValueError('Delta cannot be zero')
        return v


# ---------- Admin ----------
class AdminUserAction(BaseModel):
    note: Optional[str] = Field(default=None, max_length=280)


class AdminChipRequestAction(BaseModel):
    note: Optional[str] = Field(default=None, max_length=280)


class AnnouncementCreate(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    body: str = Field(min_length=2, max_length=2000)
    pinned: bool = False
    active: bool = True


class AnnouncementUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=2, max_length=120)
    body: Optional[str] = Field(default=None, min_length=2, max_length=2000)
    pinned: Optional[bool] = None
    active: Optional[bool] = None


class GameUpdate(BaseModel):
    status: Optional[str] = None
    featured: Optional[bool] = None

    @field_validator('status')
    @classmethod
    def valid_status(cls, v):
        if v is not None and v not in ('COMING_SOON', 'ENABLED', 'DISABLED', 'MAINTENANCE', 'UPDATE_REQUIRED', 'RETIRED'):
            raise ValueError('Invalid game status')
        return v


class SystemConfigUpdate(BaseModel):
    maintenance_mode: Optional[bool] = None
    maintenance_message: Optional[str] = Field(default=None, max_length=500)
    min_client_version: Optional[str] = None


class SettingsUpdate(BaseModel):
    sound_enabled: Optional[bool] = None
    music_enabled: Optional[bool] = None
    haptics_enabled: Optional[bool] = None
    reduced_motion: Optional[bool] = None
    high_contrast: Optional[bool] = None


class AdminSetPassword(BaseModel):
    """Admin-initiated password reset for an existing account."""
    password: str = Field(min_length=8, max_length=128)

    _password_bytes = field_validator('password')(_bcrypt_password_size)


class ReturnChipsRequestCreate(BaseModel):
    """Player asks the operator to return chips to the admin. Chips stay in the
    player's balance until the admin approves, then they are deducted."""
    amount: int = Field(ge=1, le=1_000_000)
    note: Optional[str] = Field(default=None, max_length=280)


class SupportMessageCreate(BaseModel):
    """A support/inbox message between a user and the admin."""
    body: str = Field(min_length=1, max_length=2000)


# ---------- Distributor CRM ----------
class DistributorCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    code: str = Field(min_length=4, max_length=12)
    # Basis points, not a percentage float. 25.5% is 2550. A commission rate
    # multiplies money, and money must not be multiplied by a float.
    rate_bps: int = Field(ge=0, le=10000)
    email: Optional[str] = None
    phone: Optional[str] = None
    note: Optional[str] = None


class DistributorRate(BaseModel):
    rate_bps: int = Field(ge=0, le=10000)
    note: Optional[str] = None


class DistributorStatus(BaseModel):
    status: str

    @field_validator('status')
    @classmethod
    def known_status(cls, v):
        allowed = {'ACTIVE', 'SUSPENDED', 'TERMINATED'}
        u = str(v).upper()
        if u not in allowed:
            raise ValueError(f'Status must be one of {", ".join(sorted(allowed))}')
        return u


class DistributorLogin(BaseModel):
    """Portal credentials for a distributor. The Login ID is their code."""
    email: str
    # Left optional so the operator can have one generated rather than inventing
    # (and then emailing) a weak one.
    password: Optional[str] = Field(default=None, min_length=8, max_length=64)

    _password_bytes = field_validator('password')(_bcrypt_password_size)


class LimitSet(BaseModel):
    kind: str            # DEPOSIT | LOSS
    period: str          # DAY | WEEK | MONTH
    # None means "no limit", which is the largest possible increase and waits
    # like any other.
    amount: Optional[int] = Field(default=None, ge=0)


class ExclusionCreate(BaseModel):
    kind: str = 'BREAK'
    days: Optional[int] = Field(default=None, ge=1, le=3650)
    reason: Optional[str] = None
    # A permanent self-exclusion is typed out in full, because a mis-tap must
    # not close an account forever.
    confirm: Optional[str] = None


class ComplianceConfigUpdate(BaseModel):
    market_mode: Optional[str] = None
    markets: Optional[list] = None
    min_age: Optional[int] = None
    min_age_by_country: Optional[dict] = None
    enforce_market_on_login: Optional[bool] = None
    require_age_verification: Optional[bool] = None
    limit_increase_delay_hours: Optional[int] = Field(default=None, ge=0, le=168)
    reactivation_cooling_hours: Optional[int] = Field(default=None, ge=0, le=168)


class AgeVerify(BaseModel):
    verified: bool = True
    note: Optional[str] = None


class AdminExclusion(BaseModel):
    days: Optional[int] = Field(default=None, ge=1, le=3650)
    reason: str


class PlayerReassign(BaseModel):
    distributor_id: str
    note: Optional[str] = None


class CommissionSettle(BaseModel):
    period_start: str
    period_end: Optional[str] = None
    # A settled period is never silently reworked. Redoing one is an explicit
    # new version, and the previous version is kept so a statement already sent
    # still reproduces.
    version: int = Field(default=1, ge=1, le=99)


class PayoutAction(BaseModel):
    note: Optional[str] = None


class PayoutPaid(BaseModel):
    # Required: an unreferenced payment cannot be reconciled against a bank
    # statement, and a payout nobody can trace is a payout nobody can prove.
    payment_ref: str = Field(min_length=2, max_length=80)


class ClawbackCreate(BaseModel):
    amount: int = Field(gt=0)
    reason: str = Field(min_length=4, max_length=300)


class AdminSetEmail(BaseModel):
    email: EmailStr
