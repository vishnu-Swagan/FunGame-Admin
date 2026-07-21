import { useState } from "react";
import { toast } from "sonner";
import { UserPlus, Copy, Check, Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";

const genPassword = () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pw = "";
  const arr = new Uint32Array(10);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 10; i++) pw += chars[arr[i] % chars.length];
  return pw + "@" + Math.floor(Math.random() * 90 + 10);
};

const suggestUsername = (fullName) =>
  (fullName || "player")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("_")
    .slice(0, 18) + "_" + Math.floor(Math.random() * 900 + 100);

export default function AdminSignups() {
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [userEdited, setUserEdited] = useState(false);
  const [password, setPassword] = useState(genPassword());
  const [startingChips, setStartingChips] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // {username, password} after create
  const [copied, setCopied] = useState(false);

  const onName = (v) => {
    setFullName(v);
    if (!userEdited) setUsername(suggestUsername(v));
  };

  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/users", {
        full_name: fullName.trim(),
        username: username.trim().toLowerCase(),
        password,
        starting_chips: Number(startingChips) || 0,
      });
      setCreated({ username: data.username, password });
      setCopied(false);
      toast.success(data.message);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFullName("");
    setUsername("");
    setUserEdited(false);
    setPassword(genPassword());
    setStartingChips(1000);
    setCreated(null);
    setCopied(false);
  };

  const copyCreds = async () => {
    try {
      await navigator.clipboard.writeText(`FunGame login\nLogin ID: ${created.username}\nPassword: ${created.password}`);
      setCopied(true);
      toast.success("Credentials copied");
    } catch (_e) {
      toast.error("Copy failed — note them down manually");
    }
  };

  return (
    <div className="space-y-4 max-w-xl" data-testid="admin-create-user-page">
      <div>
        <h1 className="font-display text-2xl text-white flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" /> Create user
        </h1>
        <p className="text-sm text-white/55 mt-0.5">Provision a player account directly. Hand the Login ID and password to the player — they log in with those.</p>
      </div>

      {created ? (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-5 space-y-4" data-testid="created-user-card">
          <p className="text-sm text-white/70">Account created. Share these credentials with the player — the password won't be shown again.</p>
          <div className="rounded-xl border border-primary/35 bg-primary/10 p-4 space-y-1.5" data-testid="created-credentials">
            <p className="text-sm"><span className="text-white/55">Login ID:</span> <span className="font-bold text-primary">{created.username}</span></p>
            <p className="text-sm"><span className="text-white/55">Password:</span> <span className="font-mono font-bold text-white">{created.password}</span></p>
          </div>
          <div className="flex gap-2">
            <Button data-testid="copy-credentials" onClick={copyCreds} className="flex-1 font-bold">
              {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />} {copied ? "Copied" : "Copy credentials"}
            </Button>
            <Button data-testid="create-another" variant="outline" className="border-white/15" onClick={reset}>Create another</Button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">Player name</Label>
            <Input id="cu-name" data-testid="create-name-input" value={fullName} onChange={(e) => onName(e.target.value)} placeholder="e.g. Ravi Kumar" className="bg-white/5 border-white/12" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-username">Login ID (username)</Label>
            <Input id="cu-username" data-testid="create-username-input" value={username} onChange={(e) => { setUserEdited(true); setUsername(e.target.value); }} placeholder="e.g. ravi_kumar_101" className="bg-white/5 border-white/12" />
            <p className="text-[11px] text-white/40">3-24 chars: letters, numbers, dot or underscore. Must be unique.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-password">Password</Label>
            <div className="flex gap-2">
              <Input id="cu-password" data-testid="create-password-input" value={password} onChange={(e) => setPassword(e.target.value)} className="bg-white/5 border-white/12 font-mono" />
              <Button type="button" variant="outline" data-testid="create-generate-password" onClick={() => setPassword(genPassword())} className="border-white/15 shrink-0" aria-label="Generate password">
                <Dices className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[11px] text-white/40">At least 8 characters.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-chips">Starting play chips</Label>
            <Input id="cu-chips" data-testid="create-chips-input" type="number" min={0} max={1000000} value={startingChips} onChange={(e) => setStartingChips(e.target.value)} className="bg-white/5 border-white/12" />
          </div>
          <Button data-testid="create-user-button" onClick={create} disabled={busy || fullName.trim().length < 1 || username.trim().length < 3 || password.length < 8} className="w-full font-bold">
            {busy ? "Creating…" : "Create account"}
          </Button>
        </div>
      )}
    </div>
  );
}
