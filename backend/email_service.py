"""Abstracted email service.

Providers: demo (default), resend, sendgrid, smtp.
Switch via EMAIL_PROVIDER env var. In demo mode, codes are logged and
returned to the caller so the frontend can display them (development only).
"""
import os
import asyncio
import logging

logger = logging.getLogger('email')

EMAIL_PROVIDER = os.environ.get('EMAIL_PROVIDER', 'demo')
APP_ENV = os.environ.get('APP_ENV', 'development')


def _code_email_html(title: str, intro: str, code: str) -> str:
    """Branded HTML template (inline CSS + table layout for email clients)."""
    return f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#120b06;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="background-color:#1e130a;border:1px solid #b45309;border-radius:14px;overflow:hidden;">
      <tr><td style="background-color:#2b1a0c;padding:20px 28px;text-align:center;border-bottom:1px solid #b4530955;">
        <span style="font-family:Georgia,serif;font-size:26px;font-weight:bold;color:#ffd447;letter-spacing:1px;">FunGame</span>
      </td></tr>
      <tr><td style="padding:28px;">
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;color:#ffffff;margin:0 0 10px;">{title}</p>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d6c9b8;margin:0 0 20px;line-height:1.5;">{intro}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="background-color:#120b06;border:1px dashed #b45309;border-radius:10px;padding:16px;">
            <span style="font-family:'Courier New',monospace;font-size:30px;font-weight:bold;letter-spacing:10px;color:#ffd447;">{code}</span>
          </td></tr>
        </table>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#a8977f;margin:20px 0 0;">This code expires in 15 minutes. If you did not request it, you can safely ignore this email.</p>
      </td></tr>
      <tr><td style="background-color:#2b1a0c;padding:14px 28px;text-align:center;border-top:1px solid #b4530955;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#a8977f;">PLAY CHIPS ONLY · For entertainment only</span>
      </td></tr>
    </table>
  </td></tr>
</table>
"""


class EmailService:
    @staticmethod
    async def send_verification_code(to_email: str, code: str) -> dict:
        subject = 'FunGame — Verify your email'
        body = f'Your FunGame verification code is: {code}\nThis code expires in 15 minutes.\n\nPLAY CHIPS ONLY'
        html = _code_email_html('Verify your email', 'Welcome to FunGame! Enter this code in the app to verify your email address:', code)
        return await EmailService._send(to_email, subject, body, code, html)

    @staticmethod
    async def send_password_reset_code(to_email: str, code: str) -> dict:
        subject = 'FunGame — Password reset code'
        body = f'Your FunGame password reset code is: {code}\nThis code expires in 15 minutes.'
        html = _code_email_html('Reset your password', 'Use this code in the app to reset your FunGame password:', code)
        return await EmailService._send(to_email, subject, body, code, html)

    @staticmethod
    async def _send(to_email: str, subject: str, body: str, code: str, html: str = None) -> dict:
        provider = os.environ.get('EMAIL_PROVIDER', 'demo')
        if provider == 'resend':
            return await EmailService._send_resend(to_email, subject, body, html)
        if provider == 'sendgrid':
            return await EmailService._send_sendgrid(to_email, subject, body)
        if provider == 'smtp':
            return await EmailService._send_smtp(to_email, subject, body)
        # demo mode: log only; the code is surfaced via API in development
        logger.info(f"[DEMO EMAIL] to={to_email} subject={subject} code={code}")
        return {'sent': True, 'provider': 'demo'}

    @staticmethod
    async def _send_resend(to_email: str, subject: str, body: str, html: str = None) -> dict:
        try:
            import resend
            api_key = os.environ.get('RESEND_API_KEY')
            sender = os.environ.get('SENDER_EMAIL', 'onboarding@resend.dev')
            if not api_key:
                logger.error('Resend not configured (RESEND_API_KEY missing)')
                return {'sent': False, 'provider': 'resend', 'error': 'not_configured'}
            resend.api_key = api_key
            params = {
                'from': f'FunGame <{sender}>',
                'to': [to_email],
                'subject': subject,
                'html': html or f'<pre style="font-family:Arial,sans-serif">{body}</pre>',
                'text': body,
            }
            # Resend SDK is synchronous - run in a thread to keep the event loop free
            result = await asyncio.to_thread(resend.Emails.send, params)
            email_id = result.get('id') if isinstance(result, dict) else getattr(result, 'id', None)
            logger.info(f'Resend email sent to={to_email} id={email_id}')
            return {'sent': True, 'provider': 'resend', 'email_id': email_id}
        except Exception as e:
            # Testing-mode restriction, invalid recipient, rate limits, etc.
            logger.error(f'Resend send failed: {type(e).__name__}: {e}')
            return {'sent': False, 'provider': 'resend', 'error': str(type(e).__name__)}

    @staticmethod
    async def _send_sendgrid(to_email: str, subject: str, body: str) -> dict:
        try:
            from sendgrid import SendGridAPIClient
            from sendgrid.helpers.mail import Mail
            api_key = os.environ.get('SENDGRID_API_KEY')
            sender = os.environ.get('SENDER_EMAIL')
            if not api_key or not sender:
                logger.error('SendGrid not configured (SENDGRID_API_KEY / SENDER_EMAIL missing)')
                return {'sent': False, 'provider': 'sendgrid', 'error': 'not_configured'}
            message = Mail(from_email=sender, to_emails=to_email, subject=subject, plain_text_content=body)
            sg = SendGridAPIClient(api_key)
            resp = sg.send(message)
            return {'sent': 200 <= resp.status_code < 300, 'provider': 'sendgrid'}
        except Exception as e:
            logger.error(f'SendGrid send failed: {type(e).__name__}')
            return {'sent': False, 'provider': 'sendgrid', 'error': str(type(e).__name__)}

    @staticmethod
    async def _send_smtp(to_email: str, subject: str, body: str) -> dict:
        try:
            import smtplib
            from email.mime.text import MIMEText
            host = os.environ.get('SMTP_HOST')
            port = int(os.environ.get('SMTP_PORT', '587'))
            username = os.environ.get('SMTP_USERNAME')
            password = os.environ.get('SMTP_PASSWORD')
            sender = os.environ.get('SENDER_EMAIL', username)
            if not host or not username or not password:
                logger.error('SMTP not configured')
                return {'sent': False, 'provider': 'smtp', 'error': 'not_configured'}
            msg = MIMEText(body)
            msg['Subject'] = subject
            msg['From'] = sender
            msg['To'] = to_email
            with smtplib.SMTP(host, port) as server:
                server.starttls()
                server.login(username, password)
                server.sendmail(sender, [to_email], msg.as_string())
            return {'sent': True, 'provider': 'smtp'}
        except Exception as e:
            logger.error(f'SMTP send failed: {type(e).__name__}')
            return {'sent': False, 'provider': 'smtp', 'error': str(type(e).__name__)}


def is_dev_mode() -> bool:
    return os.environ.get('APP_ENV', 'development') == 'development' and os.environ.get('EMAIL_PROVIDER', 'demo') == 'demo'
