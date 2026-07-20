import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { MessagesSquare, Send, ArrowLeft, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, errMsg } from "@/lib/api";
import { PageTransition, EmptyState, timeAgo } from "@/components/common";

export default function AdminSupport() {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(null); // {user_id, user_email, user_display_name}
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const loadThreads = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/support/threads");
      setThreads(data.threads || []);
    } catch (e) {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  const openThread = useCallback(async (t) => {
    setActive(t);
    try {
      const { data } = await api.get(`/admin/support/threads/${t.user_id}`);
      setMessages(data.messages || []);
      setThreads((prev) => prev.map((x) => (x.user_id === t.user_id ? { ...x, unread: 0 } : x)));
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  useEffect(() => {
    loadThreads();
    const iv = setInterval(loadThreads, 5000);
    return () => clearInterval(iv);
  }, [loadThreads]);

  useEffect(() => {
    if (!active) return;
    const iv = setInterval(async () => {
      try {
        const { data } = await api.get(`/admin/support/threads/${active.user_id}`);
        setMessages(data.messages || []);
      } catch (e) {
        /* silent */
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [active]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async () => {
    const body = reply.trim();
    if (!body || !active) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/admin/support/threads/${active.user_id}/reply`, { body });
      setMessages((m) => [...m, data.item]);
      setReply("");
      loadThreads();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <MessagesSquare className="h-6 w-6 text-primary" /> Support
      </h1>

      {active ? (
        <div className="rounded-2xl border border-white/10 bg-card/55 flex flex-col h-[70vh]">
          <div className="flex items-center gap-2 p-3 border-b border-white/10">
            <button onClick={() => setActive(null)} className="h-8 w-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{active.user_display_name || active.user_email}</p>
              <p className="text-[11px] text-white/45 truncate">{active.user_email}</p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2.5" data-testid="admin-support-thread">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.sender === "ADMIN" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${m.sender === "ADMIN" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-white/8 text-white/90 rounded-bl-sm"}`}>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={`text-[10px] mt-0.5 ${m.sender === "ADMIN" ? "text-primary-foreground/70" : "text-white/40"}`}>{timeAgo(m.created_at)}</p>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="p-3 border-t border-white/10 flex items-end gap-2">
            <Textarea
              data-testid="admin-support-reply-input"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Type a reply…"
              className="rounded-xl bg-white/5 border-white/12 min-h-[44px] max-h-28 resize-none"
            />
            <Button data-testid="admin-support-send" onClick={send} disabled={busy || !reply.trim()} className="h-11 w-11 rounded-xl p-0 shrink-0">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : loading ? (
        <div className="h-40 rounded-2xl fg-shimmer border border-white/5" />
      ) : threads.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="No messages yet" subtitle="Player support messages will appear here." />
      ) : (
        <div className="rounded-2xl border border-white/10 divide-y divide-white/5 overflow-hidden" data-testid="admin-support-threads">
          {threads.map((t) => (
            <button
              key={t.user_id}
              data-testid="admin-support-thread-item"
              onClick={() => openThread(t)}
              className="w-full text-left p-3.5 hover:bg-white/5 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-sm truncate">{t.user_display_name || t.user_email}</p>
                  {t.unread > 0 && (
                    <span className="shrink-0 h-5 min-w-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-extrabold flex items-center justify-center tabular-nums">{t.unread}</span>
                  )}
                </div>
                <p className={`text-[12px] truncate ${t.unread > 0 ? "text-white/80 font-medium" : "text-white/45"}`}>
                  {t.last_sender === "ADMIN" ? "You: " : ""}{t.last_body}
                </p>
              </div>
              <span className="text-[10px] text-white/40 shrink-0">{timeAgo(t.last_at)}</span>
            </button>
          ))}
        </div>
      )}
    </PageTransition>
  );
}
