import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AtSign, CalendarDays, KeyRound, Phone, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/AuthContext";
import { api, errMsg } from "@/lib/api";
import { Card, Pill, pct, shortDate } from "./partnerBits";

export default function PartnerProfile() {
  const { user } = useAuth();
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/distributor/me");
      setAccount(data);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-white/50">Loading…</p>;
  if (!account) return <p className="text-sm text-white/50">Could not load your distributor profile.</p>;

  const distributor = account.distributor;
  return (
    <div className="space-y-5" data-testid="partner-profile">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <UserRound className="h-5 w-5 text-primary" /> Profile
        </h1>
        <p className="mt-1 text-xs text-white/55">Your distributor identity and role-isolated portal access.</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xl font-bold text-white">{distributor.name}</p>
            <p className="mt-1 font-mono text-sm text-primary">{distributor.code}</p>
          </div>
          <Pill>{distributor.status}</Pill>
        </div>
        <dl className="mt-4 divide-y divide-white/8 text-sm">
          <ProfileRow icon={KeyRound} label="Login ID" value={user?.username || user?.login_id || distributor.code} />
          <ProfileRow icon={AtSign} label="Email" value={distributor.email || user?.email || "Not recorded"} />
          <ProfileRow icon={Phone} label="Phone" value={distributor.phone || "Not recorded"} />
          <ProfileRow icon={CalendarDays} label="Distributor since" value={shortDate(distributor.since)} />
          <ProfileRow label="Current commission rate" value={`${pct(account.rate_bps)}%`} />
          <ProfileRow label="Settlement timezone" value={account.settlement_timezone || "Platform default"} />
        </dl>
      </Card>

      <div className="rounded-2xl border border-primary/25 bg-primary/8 p-4 text-xs leading-relaxed text-white/65">
        Profile identity fields are maintained by an administrator so referral attribution remains auditable. Request a correction through{" "}
        <Link className="font-semibold text-primary" to="/distributor/support">Support</Link>.
      </div>
    </div>
  );
}

function ProfileRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="flex items-center gap-2 text-white/50">{Icon && <Icon className="h-3.5 w-3.5" />}{label}</dt>
      <dd className="max-w-[60%] break-words text-right font-medium text-white/85">{value}</dd>
    </div>
  );
}
