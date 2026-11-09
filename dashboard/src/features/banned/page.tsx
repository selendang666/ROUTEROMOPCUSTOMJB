import { Home } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";

const BANNED_BACKDROP_URL = `${import.meta.env.BASE_URL}default-backgrounds.webp`;

export function BannedPage() {
  const rid = (() => {
    try {
      return new URLSearchParams(window.location.search).get("rid")?.trim() || "";
    } catch {
      return "";
    }
  })();
  const navigate = useNavigate();
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${BANNED_BACKDROP_URL})` }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-black/20" />
      <div className="relative w-full max-w-[26rem] rounded-[var(--radius-xl)] border border-white/15 bg-black/30 p-8 text-center shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-white/60">Access denied</p>
        <h1 className="text-5xl font-black tracking-tight text-white">403</h1>
        <p className="mt-2 text-sm font-medium text-white">You don’t have access to this site.</p>
        <p className="mt-1 text-xs leading-relaxed text-white/60">
          Your IP has been temporarily restricted due to suspicious activity or rate limits.
          <br />
          Try again later or contact your administrator.
        </p>
        <p className="mt-4 font-mono text-[10px] tracking-wide text-white/40">
          {rid ? `${rid} · IP_BANNED` : "ERR403 · IP_BANNED"}
        </p>
        <div className="mt-6">
          <Button onClick={() => navigate("/")} className="w-full gap-2">
            <Home size={16} aria-hidden="true" />
            Back to Home
          </Button>
        </div>
      </div>
    </div>
  );
}
