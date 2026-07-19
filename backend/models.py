"""Pydantic request/response models for FunGame API."""
import re
from pydantic import BaseModel, Field, EmailStr, field_validator
from typing import Optional, List


# ---------- Auth ----------
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class SignupRequestCreate(BaseModel):
    """Public account request - admin verifies and assigns Login ID + password."""
    full_name: str = Field(min_length=2, max_length=64)
    email: EmailStr
    date_of_birth: str  # YYYY-MM-DD
    phone: str = Field(min_length=7, max_length=20)

    @field_validator('phone')
    @classmethod
    def phone_with_country_code(cls, v):
        cleaned = v.strip().replace(' ', '').replace('-', '')
        if not re.fullmatch(r'\+\d{6,15}', cleaned):
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

    @field_validator('username')
    @classmethod
    def valid_username(cls, v):
        v = v.strip().lower()
        if not re.fullmatch(r'[a-z0-9][a-z0-9._]{2,23}', v):
            raise ValueError('Username must be 3-24 chars: letters, numbers, dot or underscore')
        return v


class VerifyEmailRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=8)


class ResendVerificationRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)  # Login ID (username) or email
    password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str
    new_password: str = Field(min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


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


# ---------- Chips / Points ----------
class ChipRequestCreate(BaseModel):
    amount: int = Field(gt=0, le=1_000_000)
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
