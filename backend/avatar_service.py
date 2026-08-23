"""Player-avatar catalogue and safe uploaded-image normalization.

Preset avatars are immutable public frontend assets. Uploaded avatars are
normalized before storage so the application never serves caller-controlled
HTML/SVG, metadata, animation, or an arbitrarily large decoded image.
"""
from __future__ import annotations

import hashlib
import io
import re
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError


LEGACY_AVATAR_KEYS = frozenset({
    "star", "crown", "gem", "zap", "rocket", "sun",
    "moon", "heart", "spade", "club", "diamond", "dice",
})
CARTOON_AVATAR_KEYS = tuple(f"avatar-{index:02d}" for index in range(1, 61))
PLAYER_AVATAR_KEYS = frozenset((*LEGACY_AVATAR_KEYS, *CARTOON_AVATAR_KEYS))

AVATAR_ASSET_PATH = "/game-art/avatars/cartoon"
AVATAR_ASSET_EXTENSION = ".png"
ALLOWED_UPLOAD_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_DECODED_PIXELS = 20_000_000
MIN_IMAGE_SIDE = 96
OUTPUT_IMAGE_SIDE = 512
OUTPUT_CONTENT_TYPE = "image/webp"
UPLOAD_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class AvatarImageError(ValueError):
    """A user-supplied image failed an avatar safety requirement."""


def deterministic_avatar_key(identity: str) -> str:
    """Return one stable cartoon preset for a new account identity."""
    normalized = str(identity or "").strip().casefold()
    digest = hashlib.sha256(f"chakri-avatar-v1\0{normalized}".encode("utf-8")).digest()
    return CARTOON_AVATAR_KEYS[int.from_bytes(digest[:8], "big") % len(CARTOON_AVATAR_KEYS)]


def legacy_avatar_upgrade_fields(user: dict) -> dict:
    """Return an idempotent preset upgrade for one legacy player profile.

    Existing catalogue presets and personal uploads are intentional choices and
    are never reassigned. Only a missing avatar or one of the twelve retired
    symbolic keys is upgraded, using the immutable user id as the stable seed.
    """
    if user.get("role") != "PLAYER" or not user.get("id"):
        return {}
    if (
        user.get("avatar_source") == "UPLOAD"
        or user.get("avatar_upload_id")
        or user.get("avatar_url")
    ):
        return {}
    current = user.get("avatar")
    if current not in LEGACY_AVATAR_KEYS and current not in (None, ""):
        return {}
    return {
        "avatar": deterministic_avatar_key(user["id"]),
        "avatar_source": "PRESET",
        "avatar_assignment_version": 1,
    }


def preset_asset_path(key: str) -> str:
    if key not in CARTOON_AVATAR_KEYS:
        raise ValueError("Unknown cartoon avatar")
    return f"{AVATAR_ASSET_PATH}/{key}{AVATAR_ASSET_EXTENSION}"


def upload_id_for_user(user_id: str) -> str:
    """Use a stable opaque id so one player can own at most one upload row."""
    return hashlib.sha256(f"chakri-avatar-upload-v1\0{user_id}".encode("utf-8")).hexdigest()[:32]


def uploaded_avatar_path(upload_id: str) -> str:
    if not UPLOAD_ID_PATTERN.fullmatch(str(upload_id or "")):
        raise ValueError("Invalid avatar upload id")
    return f"/api/avatars/uploads/{upload_id}"


def _has_alpha(image: Image.Image) -> bool:
    return image.mode in ("RGBA", "LA") or (
        image.mode == "P" and "transparency" in image.info
    )


def normalize_uploaded_avatar(payload: bytes, declared_content_type: str) -> dict:
    """Decode, validate and re-encode one avatar as a bounded square WebP.

    Pillow is used as a decoder rather than trusting the filename or request
    MIME type. Re-encoding strips EXIF and other source metadata and prevents
    active formats such as SVG from reaching the public image endpoint.
    """
    content_type = str(declared_content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_UPLOAD_CONTENT_TYPES:
        raise AvatarImageError("Upload a JPEG, PNG, or WebP image.")
    if not payload:
        raise AvatarImageError("The avatar image is empty.")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise AvatarImageError("The avatar image must be 5 MB or smaller.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as source:
                detected_format = str(source.format or "").upper()
                if detected_format not in {"JPEG", "PNG", "WEBP"}:
                    raise AvatarImageError("Upload a valid JPEG, PNG, or WebP image.")
                expected_format = {
                    "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP",
                }[content_type]
                if detected_format != expected_format:
                    raise AvatarImageError("The image content does not match its file type.")
                if getattr(source, "is_animated", False) or int(getattr(source, "n_frames", 1)) != 1:
                    raise AvatarImageError("Animated avatar images are not supported.")
                width, height = source.size
                if min(width, height) < MIN_IMAGE_SIDE:
                    raise AvatarImageError("The avatar image must be at least 96 by 96 pixels.")
                if width * height > MAX_DECODED_PIXELS:
                    raise AvatarImageError("The avatar image dimensions are too large.")
                source.load()
                oriented = ImageOps.exif_transpose(source)
                mode = "RGBA" if _has_alpha(oriented) else "RGB"
                normalized = oriented.convert(mode)
    except AvatarImageError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, UnidentifiedImageError,
            OSError, SyntaxError, ValueError) as exc:
        raise AvatarImageError("The uploaded file is not a safe, readable image.") from exc

    normalized.thumbnail(
        (OUTPUT_IMAGE_SIDE, OUTPUT_IMAGE_SIDE),
        Image.Resampling.LANCZOS,
    )
    canvas_mode = "RGBA" if normalized.mode == "RGBA" else "RGB"
    canvas_color = (0, 0, 0, 0) if canvas_mode == "RGBA" else (24, 17, 20)
    canvas = Image.new(canvas_mode, (OUTPUT_IMAGE_SIDE, OUTPUT_IMAGE_SIDE), canvas_color)
    left = (OUTPUT_IMAGE_SIDE - normalized.width) // 2
    top = (OUTPUT_IMAGE_SIDE - normalized.height) // 2
    canvas.paste(normalized, (left, top), normalized if normalized.mode == "RGBA" else None)

    output = io.BytesIO()
    canvas.save(output, format="WEBP", quality=88, method=6, exact=True)
    encoded = output.getvalue()
    return {
        "data": encoded,
        "content_type": OUTPUT_CONTENT_TYPE,
        "width": OUTPUT_IMAGE_SIDE,
        "height": OUTPUT_IMAGE_SIDE,
        "size": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }
