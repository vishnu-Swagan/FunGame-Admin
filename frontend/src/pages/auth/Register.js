import { AuthShell } from "@/pages/auth/AuthShell";
import RegisterForm from "@/pages/auth/forms/RegisterForm";
import { useAuthCapabilities } from "@/lib/authCapabilities";

/** Legacy route wrapper — production redirects `/register` → `/?auth=register`. */
export default function Register() {
  const { capabilities } = useAuthCapabilities();
  const manualReview = capabilities?.registration_mode === "ADMIN_REVIEW";
  return (
    <AuthShell
      title="Create your account"
      subtitle={manualReview
        ? "Enter your details and create a password. An administrator will review your account before you can play."
        : "Enter your name, mobile number, and email. We send one SMS code, then you create a password. Virtual chips have no cash value."}
      backTo="/"
    >
      <RegisterForm />
    </AuthShell>
  );
}
