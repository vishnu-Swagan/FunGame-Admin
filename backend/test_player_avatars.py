"""Account avatar catalogue, selection, upload, and compatibility tests."""
from __future__ import annotations

import io
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from mongomock_motor import AsyncMongoMockClient
from PIL import Image
from pydantic import ValidationError
from starlette.datastructures import Headers, UploadFile


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "player_avatar_test_import")
os.environ.setdefault("JWT_SECRET", "avatar-test-jwt-secret-with-at-least-32-bytes")

import auth_utils
import routes_player
import routes_auth
from avatar_service import (
    CARTOON_AVATAR_KEYS,
    LEGACY_AVATAR_KEYS,
    MAX_UPLOAD_BYTES,
    PLAYER_AVATAR_KEYS,
    deterministic_avatar_key,
    legacy_avatar_upgrade_fields,
    normalize_uploaded_avatar,
)
from models import (
    OnboardingProfileRequest,
    PlayerAvatarSelection,
    PlayerProfileUpdate,
    RegisterRequest,
)


def image_bytes(image_format="PNG", *, size=(240, 180), color=(47, 173, 122, 255)):
    output = io.BytesIO()
    Image.new("RGBA", size, color).save(output, format=image_format)
    return output.getvalue()


def uploaded_file(payload: bytes, content_type="image/png", filename="avatar.png"):
    return UploadFile(
        io.BytesIO(payload),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


class PlayerAvatarTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client["player_avatar_test"]
        self.original_database = routes_player.db
        self.original_auth_database = auth_utils.db
        self.original_storage_ready = routes_player._avatar_storage_ready
        routes_player.db = self.database
        auth_utils.db = self.database
        routes_player._avatar_storage_ready = False
        self.player = {
            "id": "player-avatar-1",
            "role": "PLAYER",
            "status": "ACTIVE",
            "display_name": "Royal Player",
            "avatar": "star",  # pre-rollout legacy key
        }
        await self.database.users.insert_one(dict(self.player))

    async def asyncTearDown(self):
        routes_player.db = self.original_database
        auth_utils.db = self.original_auth_database
        routes_player._avatar_storage_ready = self.original_storage_ready
        self.client.close()

    def test_catalogue_has_sixty_png_presets_and_preserves_legacy_keys(self):
        self.assertEqual(len(CARTOON_AVATAR_KEYS), 60)
        self.assertEqual(CARTOON_AVATAR_KEYS[0], "avatar-01")
        self.assertEqual(CARTOON_AVATAR_KEYS[-1], "avatar-60")
        self.assertTrue(LEGACY_AVATAR_KEYS < PLAYER_AVATAR_KEYS)

        self.assertEqual(PlayerAvatarSelection(avatar="avatar-60").avatar, "avatar-60")
        self.assertEqual(PlayerProfileUpdate(avatar="crown").avatar, "crown")
        self.assertEqual(
            OnboardingProfileRequest(
                display_name="Player", country="India", avatar="avatar-01",
                accepted_terms=True,
            ).avatar,
            "avatar-01",
        )
        with self.assertRaises(ValidationError):
            PlayerAvatarSelection(avatar="../../unsafe.svg")
        with self.assertRaises(ValidationError):
            OnboardingProfileRequest(
                display_name="Player", country="India", avatar="unknown",
                accepted_terms=True,
            )

    def test_auto_assignment_is_stable_case_insensitive_and_in_catalogue(self):
        first = deterministic_avatar_key("Player@Example.com")
        self.assertEqual(first, deterministic_avatar_key(" player@example.com "))
        self.assertIn(first, CARTOON_AVATAR_KEYS)
        self.assertEqual(legacy_avatar_upgrade_fields({
            "id": "selected-player", "role": "PLAYER", "avatar": "avatar-33",
        }), {})
        self.assertEqual(legacy_avatar_upgrade_fields({
            "id": "custom-player", "role": "PLAYER", "avatar": "custom-v1",
        }), {})

    async def test_auth_refresh_upgrades_legacy_once_and_preserves_uploads(self):
        credentials = HTTPAuthorizationCredentials(
            scheme="Bearer",
            credentials=auth_utils.create_access_token(
                self.player["id"], self.player["role"],
            ),
        )
        first = await auth_utils.get_current_user(credentials)
        expected = deterministic_avatar_key(self.player["id"])
        self.assertEqual(first["avatar"], expected)
        self.assertEqual(first["avatar_source"], "PRESET")
        self.assertEqual(first["avatar_assignment_version"], 1)
        second = await auth_utils.get_current_user(credentials)
        self.assertEqual(second["avatar"], expected)

        uploaded = {
            "id": "uploaded-player", "role": "PLAYER", "status": "ACTIVE",
            "avatar": "star", "avatar_source": "UPLOAD",
            "avatar_upload_id": "d" * 32,
            "avatar_url": f"/api/avatars/uploads/{'d' * 32}",
        }
        await self.database.users.insert_one(uploaded)
        upload_credentials = HTTPAuthorizationCredentials(
            scheme="Bearer",
            credentials=auth_utils.create_access_token(
                uploaded["id"], uploaded["role"],
            ),
        )
        preserved = await auth_utils.get_current_user(upload_credentials)
        self.assertEqual(preserved["avatar"], "star")
        self.assertEqual(preserved["avatar_source"], "UPLOAD")
        self.assertEqual(preserved["avatar_upload_id"], "d" * 32)
        self.assertEqual(legacy_avatar_upgrade_fields(preserved), {})

    async def test_self_service_account_creation_persists_deterministic_preset(self):
        phone = "+919876543210"
        registration = RegisterRequest(
            channel="PHONE",
            identifier=phone,
            phone=phone,
            email="avatar.player@example.com",
            full_name="Avatar Player",
            date_of_birth="1990-01-01",
            country="India",
            accepted_terms=True,
            password="Strong-Password-9",
            password_confirmation="Strong-Password-9",
        )

        async def run_without_session(callback):
            return await callback(None)

        with (
            patch.object(routes_auth, "db", self.database),
            patch.object(routes_auth, "require_identity_indexes", new=AsyncMock()),
            patch.object(routes_auth, "require_registration_transactions", new=AsyncMock()),
            patch.object(
                routes_auth.crm, "require_registration_attribution_readiness",
                new=AsyncMock(),
            ),
            patch.object(routes_auth.crm, "attribute_user", new=AsyncMock()),
            patch.object(
                routes_auth.compliance, "check_eligibility",
                new=AsyncMock(return_value=(True, None, None)),
            ),
            patch.object(routes_auth, "hash_password", return_value="hashed"),
            patch.object(
                routes_auth, "_run_auth_transaction",
                side_effect=run_without_session,
            ),
        ):
            await routes_auth._register_for_admin_review(registration)

        created = await self.database.users.find_one({"phone_normalized": phone})
        self.assertEqual(created["avatar"], deterministic_avatar_key(phone))
        self.assertEqual(created["avatar_source"], "PRESET")

    async def test_authenticated_catalogue_lists_exact_local_png_paths(self):
        result = await routes_player.list_profile_avatars(self.player)
        self.assertEqual(len(result["presets"]), 60)
        self.assertEqual(
            result["presets"][0],
            {
                "key": "avatar-01",
                "asset_path": "/game-art/avatars/cartoon/avatar-01.png",
            },
        )
        self.assertEqual(result["presets"][-1]["key"], "avatar-60")
        self.assertIn("star", result["legacy_keys"])
        self.assertEqual(result["upload"]["max_bytes"], MAX_UPLOAD_BYTES)
        with self.assertRaises(HTTPException) as raised:
            await routes_player.list_profile_avatars({"id": "admin", "role": "ADMIN"})
        self.assertEqual(raised.exception.status_code, 403)

    async def test_preset_selection_clears_a_previous_upload_but_keeps_legacy_editing(self):
        await self.database.users.update_one({"id": self.player["id"]}, {"$set": {
            "avatar_source": "UPLOAD",
            "avatar_upload_id": "a" * 32,
            "avatar_url": "/api/avatars/uploads/example",
        }})
        await self.database.avatar_uploads.insert_one({
            "_id": self.player["id"], "id": "a" * 32, "user_id": self.player["id"],
        })

        selected = await routes_player.select_profile_avatar(
            PlayerAvatarSelection(avatar="avatar-60"), self.player,
        )
        self.assertEqual(selected["profile"]["avatar"], "avatar-60")
        self.assertEqual(selected["profile"]["avatar_source"], "PRESET")
        stored = await self.database.users.find_one({"id": self.player["id"]})
        self.assertNotIn("avatar_url", stored)
        self.assertNotIn("avatar_upload_id", stored)
        self.assertIsNone(await self.database.avatar_uploads.find_one({"_id": self.player["id"]}))

        legacy = await routes_player.update_profile(
            PlayerProfileUpdate(avatar="crown"), stored,
        )
        self.assertEqual(legacy["profile"]["avatar"], "crown")

    async def test_valid_upload_is_reencoded_stored_and_publicly_readable(self):
        source = image_bytes()
        result = await routes_player.upload_profile_avatar(
            uploaded_file(source), self.player,
        )
        profile = result["profile"]
        self.assertEqual(profile["avatar"], "star")  # compatible preset fallback
        self.assertEqual(profile["avatar_source"], "UPLOAD")
        self.assertRegex(profile["avatar_upload_id"], r"^[a-f0-9]{32}$")
        self.assertIn("?v=", profile["avatar_url"])

        stored = await self.database.avatar_uploads.find_one({"_id": self.player["id"]})
        self.assertEqual(stored["content_type"], "image/webp")
        self.assertEqual((stored["width"], stored["height"]), (512, 512))
        indexes = await self.database.avatar_uploads.index_information()
        self.assertTrue(indexes["id_1"]["unique"])
        with Image.open(io.BytesIO(bytes(stored["content"]))) as normalized:
            self.assertEqual(normalized.format, "WEBP")
            self.assertEqual(normalized.size, (512, 512))

        response = await routes_player.uploaded_avatar(profile["avatar_upload_id"])
        self.assertEqual(response.media_type, "image/webp")
        self.assertEqual(response.body, bytes(stored["content"]))
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    async def test_type_size_and_decoding_validation_fail_without_profile_mutation(self):
        with self.assertRaises(HTTPException) as unsupported:
            await routes_player.upload_profile_avatar(
                uploaded_file(b"<svg/>", "image/svg+xml", "avatar.svg"), self.player,
            )
        self.assertEqual(unsupported.exception.status_code, 415)

        with self.assertRaises(HTTPException) as mismatched:
            await routes_player.upload_profile_avatar(
                uploaded_file(image_bytes("PNG"), "image/jpeg", "avatar.jpg"), self.player,
            )
        self.assertEqual(mismatched.exception.status_code, 422)
        self.assertEqual(mismatched.exception.detail["code"], "AVATAR_IMAGE_INVALID")

        with self.assertRaises(HTTPException) as oversized:
            await routes_player.upload_profile_avatar(
                uploaded_file(b"x" * (MAX_UPLOAD_BYTES + 1)), self.player,
            )
        self.assertEqual(oversized.exception.status_code, 413)

        stored = await self.database.users.find_one({"id": self.player["id"]})
        self.assertEqual(stored["avatar"], "star")
        self.assertNotIn("avatar_source", stored)
        self.assertEqual(await self.database.avatar_uploads.count_documents({}), 0)

    async def test_upload_requires_an_active_player_and_unselected_images_are_private(self):
        suspended = {**self.player, "status": "SUSPENDED"}
        with self.assertRaises(HTTPException) as forbidden:
            await routes_player.upload_profile_avatar(
                uploaded_file(image_bytes()), suspended,
            )
        self.assertEqual(forbidden.exception.status_code, 403)

        uploaded = await routes_player.upload_profile_avatar(
            uploaded_file(image_bytes()), self.player,
        )
        upload_id = uploaded["profile"]["avatar_upload_id"]
        await self.database.users.update_one(
            {"id": self.player["id"]},
            {"$set": {"avatar_source": "PRESET"}},
        )
        with self.assertRaises(HTTPException) as missing:
            await routes_player.uploaded_avatar(upload_id)
        self.assertEqual(missing.exception.status_code, 404)


class AvatarNormalizerTests(unittest.TestCase):
    def test_normalizer_strips_metadata_and_rejects_small_images(self):
        normalized = normalize_uploaded_avatar(image_bytes(size=(200, 260)), "image/png")
        self.assertEqual(normalized["content_type"], "image/webp")
        self.assertEqual((normalized["width"], normalized["height"]), (512, 512))
        with self.assertRaises(ValueError):
            normalize_uploaded_avatar(image_bytes(size=(40, 40)), "image/png")


if __name__ == "__main__":
    unittest.main()
