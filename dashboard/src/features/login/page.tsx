import { Eye, EyeOff, Lock } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "../../lib/toast";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const LOGIN_BACKDROP_URL = `${import.meta.env.BASE_URL}default-backgrounds.webp`;
const LOGIN_LOGO_URL = `${import.meta.env.BASE_URL}favicon_love.webp`;

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [mode, setMode] = useState<"signin" | "signup" | "checking">("checking");

  const navigate = useNavigate();
  const [params] = useSearchParams();

  useEffect(() => {
    let cancelled = false;
    apiGet<{ initialized: boolean }>("/setup/status")
      .then((res) => {
        if (cancelled) return;
        setMode(res.initialized ? "signin" : "signup");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          window.location.replace("/console/banned");
          return;
        }
        setMode("signin");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === "signup" && (!password || !confirmPassword)) return;
    if (mode === "signin" && !password) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        if (password !== confirmPassword) {
          setError("Passwords do not match");
          setPassword("");
          setConfirmPassword("");
          setBusy(false);
          return;
        }
        await apiPost("/setup", { password, confirmPassword });
        toast.success("Account created — administrator");
      } else {
        await apiPost("/login", { password });
        toast.success("Signed in");
      }
      const next = params.get("next") || "/overview";
      navigate(next.startsWith("/") ? next : "/overview", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          window.location.replace("/console/banned");
          return;
        }
        if (err.status === 429) {
          const body = err.message;
          setRetryAfter(30);
          setError(body || "Too many attempts. Try again later.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Unexpected error");
      }
      setPassword("");
      setConfirmPassword("");
    } finally {
      setBusy(false);
    }
  };

  const isSignup = mode === "signup";
  const checking = mode === "checking";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black p-4">
      <div
        aria-hidden="true"
        data-login-backdrop
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${LOGIN_BACKDROP_URL})` }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-black/20" />
      <form
        onSubmit={submit}
        className="login-enter relative w-full max-w-[26rem] rounded-[var(--radius-xl)] border border-white/15 bg-black/30 p-6 text-white shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-8"
      >
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-[22px] border border-white/20 bg-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.24)]">
            <img src={LOGIN_LOGO_URL} alt="" width="64" height="64" className="h-full w-full object-cover" />
          </div>
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.22em] text-white/70">Private workspace</p>
            <h1 className="text-2xl font-bold tracking-tight text-white">{checking ? "Oh My Omop - Router" : isSignup ? "Create administrator" : "Oh My Omop - Router"}</h1>
            <p className="mt-1 text-sm text-white/70">{checking ? "Checking…" : isSignup ? "No account yet — set a password to create the administrator" : "Sign in to manage your gateway"}</p>
          </div>
        </div>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-xs font-semibold text-white/80">
              {isSignup ? "Password" : "Password"}
            </label>
            <div className="relative">
              <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSignup ? "Create password (≥8 chars)..." : "Enter your password..."}
                className="h-11 border-white/15 bg-black/40 pl-9 pr-10 text-white placeholder:text-white/50 backdrop-blur-sm focus:!border-white/25 focus:!bg-black/60 focus:text-white"
                autoComplete={isSignup ? "new-password" : "current-password"}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {isSignup && (
            <div className="space-y-1.5">
              <label htmlFor="confirmPassword" className="text-xs font-semibold text-white/80">
                Confirm password
              </label>
              <div className="relative">
                <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
                <Input
                  id="confirmPassword"
                  type={showConfirm ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password..."
                  className="h-11 border-white/15 bg-black/40 pl-9 pr-10 text-white placeholder:text-white/50 backdrop-blur-sm focus:!border-white/25 focus:!bg-black/60 focus:text-white"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-200">
              {error}
              {retryAfter !== null && ` (retry in ${retryAfter}s)`}
            </p>
          )}

          <Button type="submit" disabled={busy || (isSignup ? !password || !confirmPassword : !password)} className="mt-2 w-full border border-white/10 bg-white text-black shadow-[0_8px_20px_rgba(0,0,0,0.35)] hover:bg-white/90 disabled:opacity-40">
            {busy ? (isSignup ? "Creating..." : "Signing in...") : isSignup ? "Sign up" : "Sign in"}
          </Button>

          {isSignup && <p className="text-center text-xs text-white/50">First account is auto-assigned administrator</p>}
        </div>
      </form>
    </div>
  );
}
