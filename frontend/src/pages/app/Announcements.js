import { useState, useEffect } from "react";
import { Megaphone, Pin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { PageTransition, EmptyState, timeAgo } from "@/components/common";

export default function Announcements() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/announcements")
      .then(({ data }) => setItems(data.announcements || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <PageTransition className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Announcements</h1>
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Megaphone} title="No announcements" subtitle="Operator updates will appear here." />
      ) : (
        <div data-testid="announcements-feed" className="space-y-3">
          {items.map((a) => (
            <article key={a.id} data-testid="announcement-card" className="rounded-2xl bg-card/55 backdrop-blur-md border border-white/10 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{a.title}</h2>
                {a.pinned && (
                  <Badge variant="outline" className="rounded-full border-primary/35 bg-primary/10 text-primary text-[10px] font-bold px-2 py-0.5 flex items-center gap-1">
                    <Pin className="h-3 w-3" /> PINNED
                  </Badge>
                )}
              </div>
              <p className="mt-1.5 text-sm text-white/70 leading-relaxed">{a.body}</p>
              <p className="mt-2 text-[11px] text-white/40">{timeAgo(a.created_at)}</p>
            </article>
          ))}
        </div>
      )}
    </PageTransition>
  );
}
