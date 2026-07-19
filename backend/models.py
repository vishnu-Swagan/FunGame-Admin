"""Pydantic request/response models for FunGame API."""
from pydantic import BaseModel, Field, EmailStr, field_validator
from typing import Optional, List


# ---------- Auth ----------
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class VerifyEmailRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=8)


class ResendVerificationRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
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


# ---------- Chips ----------
class ChipRequestCreate(BaseModel):
    amount: int = Field(gt=0, le=1_000_000)
    note: Optional[str] = Field(default=None, max_length=280)


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
