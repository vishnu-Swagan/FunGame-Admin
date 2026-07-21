import { useState } from "react";
import { toast } from "sonner";
import { UserPlus, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errMsg } from "@/lib/api";

export default function AdminSignups() {
  const [fullName, setFullName] = useState("");
  const [startingChips, setStartingChips] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // {username, password}
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post("/admin/users", {
        full_name: fullName.trim(),
        starting_chips: Number(startingChips) || 0,
      });
      setCreated({ username: data.username, password: data.password });
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
    setStartingChips(1000);
    setCreated(null);
    setCopied(false);
  };

  const copyCreds = async () => {
    try {
      await navigator.clipboard.writeText(`FunGame login\nUsername: ${created.username}\nPassword: ${created.password}`);
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
        <p className="text-sm text-white/55 mt-0.5">
          The Username (<span className="font-mono text-white/70">GK</span> + 7 digits) and Password (7 capital letters) are issued automatically. Hand them to the player — they log in with those.
        </p>
      </div>

      {created ? (
        <div className="rounded-2xl border border-white/10 bg-card/55 p-5 space-y-4" data-testid="created-user-card">
          <p className="text-sm text-white/70">Account created. Share these credentials with the player — the password won't be shown again.</p>
          <div className="rounded-xl border border-primary/35 bg-primary/10 p-4 space-y-1.5" data-testid="created-credentials">
            <p className="text-sm"><span className="text-white/55">Username:</span> <span className="font-mono font-bold text-primary text-base tracking-wide">{created.username}</span></p>
            <p className="text-sm"><span className="text-white/55">Password:</span> <span className="font-mono font-bold text-white text-base tracking-widest">{created.password}</span></p>
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
            <Input id="cu-name" data-testid="create-name-input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Ravi Kumar" className="bg-white/5 border-white/12" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-chips">Starting play chips</Label>
            <Input id="cu-chips" data-testid="create-chips-input" type="number" min={0} max={1000000} value={startingChips} onChange={(e) => setStartingChips(e.target.value)} className="bg-white/5 border-white/12" />
          </div>
          <Button data-testid="create-user-button" onClick={create} disabled={busy || fullName.trim().length < 1} className="w-full font-bold">
            {busy ? "Creating…" : "Create account & issue login"}
          </Button>
        </div>
      )}
    </div>
  );
}
