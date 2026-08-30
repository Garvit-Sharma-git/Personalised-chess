import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth.jsx";
import { useSlowLoad } from "../lib/useSlowLoad.js";
import WakingNotice from "../components/WakingNotice.jsx";

export default function AuthPage({ mode }) {
  const { login, register, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";
  const [form, setForm] = useState({ identifier: "", email: "", username: "", password: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const slow = useSlowLoad(busy);
  const isLogin = mode === "login";

  if (user) {
    navigate(next, { replace: true });
    return null;
  }

  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isLogin) await login(form.identifier, form.password);
      else await register(form.email, form.username, form.password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-icon">♞</span>
          <h1>Chess Coach</h1>
          <p className="muted">Play friends in real time, then learn from every game.</p>
        </div>
        <form onSubmit={submit} className="form">
          {isLogin ? (
            <label>
              Email or username
              <input value={form.identifier} onChange={update("identifier")} autoComplete="username" required autoFocus />
            </label>
          ) : (
            <>
              <label>
                Email
                <input type="email" value={form.email} onChange={update("email")} autoComplete="email" required autoFocus />
              </label>
              <label>
                Username
                <input
                  value={form.username}
                  onChange={update("username")}
                  autoComplete="username"
                  minLength={3}
                  maxLength={20}
                  pattern="[A-Za-z0-9_]+"
                  title="Letters, numbers and underscores"
                  required
                />
              </label>
            </>
          )}
          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={update("password")}
              autoComplete={isLogin ? "current-password" : "new-password"}
              minLength={isLogin ? 1 : 8}
              required
            />
          </label>
          {error && <div className="error">{error}</div>}
          {slow && <WakingNotice compact />}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "…" : isLogin ? "Log in" : "Create account"}
          </button>
        </form>
        <p className="muted small center">
          {isLogin ? (
            <>
              New here? <Link to={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Log in</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
