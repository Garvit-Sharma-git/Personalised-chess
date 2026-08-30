import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth.jsx";
import { useSlowLoad } from "./lib/useSlowLoad.js";
import WakingNotice from "./components/WakingNotice.jsx";
import Layout from "./components/Layout.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import GamePage from "./pages/GamePage.jsx";
import ReviewPage from "./pages/ReviewPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const slow = useSlowLoad(loading);
  if (loading) return <div className="page-loading">{slow ? <WakingNotice /> : "Loading…"}</div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route index element={<HomePage />} />
                <Route path="game/:code" element={<GamePage />} />
                <Route path="review/:code" element={<ReviewPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
