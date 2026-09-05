import { AuthShell } from "@/pages/auth/AuthShell";
import ForgotPasswordForm from "@/pages/auth/forms/ForgotPasswordForm";

/** Legacy route wrapper — production redirects `/forgot-password` → `/?auth=forgot`. */
export default function ForgotPassword() {
  return (
    <AuthShell title="Reset password" subtitle="Reset with the verified mobile number (SMS OTP) or email." backTo="/?auth=login">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
