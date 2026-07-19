import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";
import { AuthShell } from "@/pages/auth/AuthShell";

/**
 * Public sign-up is closed. New players submit an account REQUEST with their
 * details - the admin verifies them and assigns a unique Login ID + password.
 */
export default function Register() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/auth/signup-request", {
        full_name: fullName,
        email,
        date_of_birth: dob,
        phone,
      });
      setDone(true);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthShell title="Request submitted" subtitle="You are one step away from the lounge.">
        <div data-testid="signup-success-card" className="rounded-2xl border border-[hsl(var(--emerald)/0.4)] bg-[hsl(var(--emerald)/0.1)] p-5 text-center space-y-3">
          <CheckCircle2 className="h-10 w-10 mx-auto text-[hsl(var(--emerald))]" />
          <p className="font-semibold text-white">Thanks, {fullName.split(" ")[0]}!</p>
          <p className="text-sm text-white/65 leading-relaxed">
            The admin will verify your details and share your unique <span className="text-primary font-semibold">Login ID and password</span> with you.
            Once you receive them, log in below.
          </p>
        </div>
        <Button asChild data-testid="signup-success-login-button" className="w-full h-12 rounded-xl text-base font-bold mt-5">
          <Link to="/login">Go to log in</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Request an account" subtitle="The admin verifies every player and assigns your unique Login ID and password.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="fullName">Full name</Label>
          <Input
            id="fullName"
            data-testid="signup-fullname-input"
            type="text"
            required
            minLength={2}
            maxLength={64}
            autoComplete="name"
            placeholder="Your full name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email ID</Label>
          <Input
            id="email"
            data-testid="signup-email-input"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dob">Date of birth</Label>
          <Input
            id="dob"
            data-testid="signup-dob-input"
            type="date"
            required
            max={new Date().toISOString().slice(0, 10)}
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone number (with country code)</Label>
          <Input
            id="phone"
            data-testid="signup-phone-input"
            type="tel"
            required
            autoComplete="tel"
            placeholder="+91 98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-12 rounded-xl bg-white/5 border-white/12"
          />
          <p className="text-[11px] text-white/40">Include your country code, e.g. +91, +1, +44</p>
        </div>
        <Button data-testid="auth-primary-submit-button" type="submit" disabled={busy} className="w-full h-12 rounded-xl text-base font-bold hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150">
          {busy ? "Submitting…" : "Submit request"}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-white/60">
        Already have your Login ID?{" "}
        <Link data-testid="register-login-link" to="/login" className="text-primary font-semibold hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
