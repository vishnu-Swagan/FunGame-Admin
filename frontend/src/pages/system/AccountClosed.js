import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PauseCircle, LifeBuoy, LogOut } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Disclaimer } from "@/components/common";
import { BrandWordmark } from "@/components/Brand";

/**
 * Where a player lands when the app has closed itself to them.
 *
 * This exists because the alternative is worse than it sounds: without it, an
 * excluded player taps into the app and gets a red toast on every screen, over
 * and over, with no explanation and nothing to do. Somebody who has just shut
 * themselves out deserves a clear page, the date it ends, and the two things
 * they can still do — reach support, and sign out.
 *
 * The reason is read from whatever the API last refused with, so the same
 * screen serves an exclusion, a closed market and an unverified age without
 * inventing a message it does not have.
 */
const STORE = "cc_block";

export default function AccountClosed() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) setDetail(JSON.parse(raw));
    } catch (e) { /* nothing stored, or unreadable */ }
  }, []);

  // Nothing to be closed out of if nobody is signed in.
  useEffect(() => { if (!user) navigate("/", { replace: true }); }, [user, navigate]);

  const ends = detail?.ends_at ? String(detail.ends_at).slice(0, 10) : null;
  const expired = ends && new Date(ends) <= new Date();

  const askToReturn = async () => {
    try {
      const { data } = await api.post("/responsible/reactivate");
      setStatus(data);
      if (data.status === "LIFTED") {
        localStorage.removeItem(STORE);
        toast.success(data.message);
        navigate("/", { replace: true });
      } else {
        toast.info(data.message);
      }
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="App fg-noise min-h-dvh bg-background flex items-center justify-center px-5" data-testid="account-closed">
      <div className="fg-aurora absolute top-0 left-0 right-0 h-[160px] pointer-events-none" />
      <div className="relative z-[2] w-full max-w-[400px] rounded-2xl bg-card/60 backdrop-blur-md border border-white/10 p-8 text-center">
        <BrandWordmark logoClassName="h-auto w-64 max-w-full" />
        <div className="mt-6 flex justify-center">
          <div className="h-16 w-16 rounded-2xl flex items-center justify-center border bg-amber-400/10 border-amber-400/30 text-amber-300">
            <PauseCircle className="h-7 w-7" />
          </div>
        </div>
        <h1 className="mt-5 text-2xl font-bold tracking-tight">Your account is closed to play</h1>
        <p className="mt-2 text-sm text-white/65 leading-relaxed">
          {detail?.message || "Play is not available on this account at the moment."}
        </p>

        {/* Offered only once the break has actually run out. Before that the
            honest thing is to say when, not to show a button that refuses. */}
        {expired && (
          <button onClick={askToReturn} data-testid="account-closed-return"
            className="mt-6 w-full h-11 rounded-xl bg-primary text-primary-foreground font-bold">
            {status?.status === "WAITING" ? "Request received" : "Ask to reopen my account"}
          </button>
        )}
        {status?.status === "WAITING" && (
          <p className="mt-2 text-[11px] text-white/45">{status.message}</p>
        )}

        <button onClick={() => navigate("/support")} data-testid="account-closed-support"
          className="mt-3 w-full h-11 rounded-xl border border-white/15 bg-white/5 font-semibold flex items-center justify-center gap-2">
          <LifeBuoy className="h-4 w-4" /> Contact support
        </button>
        <button
          onClick={() => { localStorage.removeItem(STORE); logout(); navigate("/", { replace: true }); }}
          data-testid="account-closed-logout"
          className="mt-3 w-full h-11 rounded-xl border border-white/10 text-white/60 font-semibold flex items-center justify-center gap-2">
          <LogOut className="h-4 w-4" /> Sign out
        </button>

        <Disclaimer className="mt-7" />
      </div>
    </div>
  );
}
