import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth.jsx";

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-icon">♞</span>
          <span>Chess Coach</span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end>
            Play
          </NavLink>
          <NavLink to="/history">History</NavLink>
          <NavLink to="/profile">Profile</NavLink>
        </nav>
        <div className="userbox">
          <Link to="/profile" className="userbox-name">
            {user?.username}
            <span className="userbox-rating">{user?.rating}</span>
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
