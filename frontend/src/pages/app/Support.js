import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Send, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, errMsg } from "@/lib/api";
import { PageTransition, timeAgo } from "@/components/common";

export default function Support() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/support/thread");
      setMessages(data.messages || []);
    } catch (e) {
      /* silent */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const { data } = await api.post("/support/message", { body });
      setMessages((m) => [...m, data.item]);
      setText("");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="min-h-[100dvh] flex flex-col max-w-2xl mx-auto w-full">
      <div className="flex items-center gap-2 p-4 border-b border-white/10 sticky top-0 bg-background/80 backdrop-blur z-10">
        <button onClick={() => navigate(-1)} data-testid="support-back" className="h-9 w-9 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center" aria-label="Back">
          <ArrowLeft className="h-4.5 w-4.5" />
        </button>
        <div>
          <p className="font-bold text-lg leading-tight flex items-center gap-1.5"><MessagesSquare className="h-5 w-5 text-primary" /> Support</p>
          <p className="text-[11px] text-white/50">Message the operator — request updates, issues, or anything.</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2.5" data-testid="support-thread">
        {loaded && messages.length === 0 && (
          <div className="text-center text-white/45 text-sm py-10">
            <MessagesSquare className="h-8 w-8 mx-auto mb-2 text-white/25" />
            No messages yet. Say hello or ask us anything — we'll reply here.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.sender === "USER" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${m.sender === "USER" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-white/8 text-white/90 rounded-bl-sm"}`}>
              {m.sender === "ADMIN" && <p className="text-[10px] font-bold text-primary/90 mb-0.5">SUPPORT</p>}
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className={`text-[10px] mt-0.5 ${m.sender === "USER" ? "text-primary-foreground/70" : "text-white/40"}`}>{timeAgo(m.created_at)}</p>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="p-3 border-t border-white/10 flex items-end gap-2 sticky bottom-0 bg-background/80 backdrop-blur">
        <Textarea
          data-testid="support-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Write a message…"
          className="rounded-xl bg-white/5 border-white/12 min-h-[46px] max-h-32 resize-none"
        />
        <Button data-testid="support-send" onClick={send} disabled={busy || !text.trim()} className="h-12 w-12 rounded-xl p-0 shrink-0">
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </PageTransition>
  );
}
