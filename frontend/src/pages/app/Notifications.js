import { useState, useEffect, useCallback } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { PageTransition, EmptyState, timeAgo } from "@/components/common";

export default function Notifications() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/notifications");
      setItems(data.notifications || []);
    } catch (e) {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = async (id) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await api.post(`/notifications/${id}/read`);
    } catch (e) {
      // silent
    }
  };

  const markAll = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await api.post("/notifications/read-all");
    } catch (e) {
      // silent
    }
  };

  const unread = items.filter((n) => !n.read).length;

  return (
    <PageTransition className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        {unread > 0 && (
          <Button data-testid="notifications-mark-all-button" variant="ghost" size="sm" onClick={markAll} className="text-primary hover:text-primary text-xs font-bold">
            <CheckCheck className="h-4 w-4 mr-1" /> Mark all read
          </Button>
        )}
      </div>
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Bell} title="No notifications" subtitle="Approvals and chip updates will land here." />
      ) : (
        <div data-testid="notifications-list" className="space-y-2.5">
          {items.map((n) => (
            <button
              key={n.id}
              data-testid="notification-item"
              onClick={() => !n.read && markRead(n.id)}
              className={`w-full text-left rounded-2xl border p-4 transition-[background-color] duration-150 ${
                n.read ? "bg-card/40 border-white/5" : "bg-card/70 border-primary/25 hover:bg-card/85"
              }`}
            >
              <div className="flex items-start gap-3">
                {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                <div className={n.read ? "opacity-65" : ""}>
                  <p className="text-sm font-semibold">{n.title}</p>
                  <p className="text-xs text-white/60 mt-1 leading-relaxed">{n.body}</p>
                  <p className="text-[11px] text-white/35 mt-1.5">{timeAgo(n.created_at)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </PageTransition>
  );
}
