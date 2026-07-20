"""App-integrity verification endpoint (Google Play Integrity API).

IMPORTANT: This is inert until PLAY_INTEGRITY_ENABLED=true AND a native client
actually sends integrity tokens. A PWABuilder TWA (pure web wrapper) cannot mint
Play Integrity tokens — that requires native Android code. See SECURITY.md.

When enabled, the backend verifies the token server-side and can gate sensitive
actions (login, chip changes) on a genuine, unmodified app installed from Play.
"""
import os
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger('security')
router = APIRouter(prefix='/security', tags=['security'])


class IntegrityCheck(BaseModel):
    token: str = Field(min_length=1, max_length=8192)
    nonce: str = Field(min_length=1, max_length=256)


def _enabled() -> bool:
    return os.environ.get('PLAY_INTEGRITY_ENABLED', 'false').lower() == 'true'


@router.post('/integrity')
async def verify_integrity(body: IntegrityCheck):
    """Verify a Play Integrity token from the native client.

    Activation checklist (see SECURITY.md for the full guide):
      1. Ship a NATIVE Android client (Capacitor + a Play Integrity plugin), not a TWA.
      2. Create a Google Cloud project, link it to your Play Console app, enable the
         Play Integrity API, and create a service account with the Integrity role.
      3. Set env: PLAY_INTEGRITY_ENABLED=true, GOOGLE_APPLICATION_CREDENTIALS (json),
         PLAY_INTEGRITY_PACKAGE=com.your.app
      4. Implement the Google API call below (decodeIntegrityToken) and assert:
         appIntegrity.appRecognitionVerdict == 'PLAY_RECOGNIZED'
         deviceIntegrity.deviceRecognitionVerdict contains 'MEETS_DEVICE_INTEGRITY'
         requestDetails.nonce == the nonce you issued (bind to the session).
    """
    if not _enabled():
        raise HTTPException(
            status_code=501,
            detail='App integrity verification is not enabled on this server. '
                   'Requires a native client + Play Integrity configuration (see SECURITY.md).',
        )
    # TODO (when a native client exists): call the Google Play Integrity API here.
    # from googleapiclient.discovery import build  # google-api-python-client
    # service = build('playintegrity', 'v1', credentials=creds)
    # verdict = service.v1().decodeIntegrityToken(
    #     packageName=os.environ['PLAY_INTEGRITY_PACKAGE'],
    #     body={'integrityToken': body.token}).execute()
    # ... assert verdicts + nonce, then return pass/fail ...
    logger.error('PLAY_INTEGRITY_ENABLED=true but verification is not yet implemented')
    raise HTTPException(status_code=501, detail='Integrity verification not implemented yet.')
