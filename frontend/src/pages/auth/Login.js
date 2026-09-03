import { useLocation } from "react-router-dom";
import { AuthShell } from "@/pages/auth/AuthShell";
import LoginForm from "@/pages/auth/forms/LoginForm";

/** Legacy route wrapper — production redirects `/login` → `/?auth=login`. */
export default function Login() {
  const location = useLocation();
  return (
    <AuthShell title="Welcome back" subtitle="Log in to enter the Chakri.Casino lounge." backTo="/">
      <LoginForm registrationSubmitted={Boolean(location.state?.registrationSubmitted)} />
    </AuthShell>
  );
}
