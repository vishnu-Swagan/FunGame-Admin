"""Abstracted email service.

Providers: demo (default), sendgrid, smtp.
Switch via EMAIL_PROVIDER env var. In demo mode, codes are logged and
returned to the caller so the frontend can display them (development only).
"""
import os
import logging

logger = logging.getLogger('email')

EMAIL_PROVIDER = os.environ.get('EMAIL_PROVIDER', 'demo')
APP_ENV = os.environ.get('APP_ENV', 'development')


class EmailService:
    @staticmethod
    async def send_verification_code(to_email: str, code: str) -> dict:
        subject = 'FunGame — Verify your email'
        body = f'Your FunGame verification code is: {code}\nThis code expires in 15 minutes.\n\nPLAY CHIPS — NO CASH VALUE'
        return await EmailService._send(to_email, subject, body, code)

    @staticmethod
    async def send_password_reset_code(to_email: str, code: str) -> dict:
        subject = 'FunGame — Password reset code'
        body = f'Your FunGame password reset code is: {code}\nThis code expires in 15 minutes.'
        return await EmailService._send(to_email, subject, body, code)

    @staticmethod
    async def _send(to_email: str, subject: str, body: str, code: str) -> dict:
        provider = os.environ.get('EMAIL_PROVIDER', 'demo')
        if provider == 'sendgrid':
            return await EmailService._send_sendgrid(to_email, subject, body)
        if provider == 'smtp':
            return await EmailService._send_smtp(to_email, subject, body)
        # demo mode: log only; the code is surfaced via API in development
        logger.info(f"[DEMO EMAIL] to={to_email} subject={subject} code={code}")
        return {'sent': True, 'provider': 'demo'}

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
