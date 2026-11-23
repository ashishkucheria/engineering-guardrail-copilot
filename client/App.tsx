import { useEffect, useState } from "react";
import { api, setApiUser, type User } from "./api.ts";
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { StandardsPage } from "./pages/StandardsPage.tsx";

type Tab = "review" | "history" | "standards";
const USER_KEY = "egc.demoUser";

function readStoredUser(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string | null>(readStoredUser);
  const [tab, setTab] = useState<Tab>("review");
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .users()
      .then((u) => {
        setUsers(u);
        setUserId((cur) => (cur && u.some((x) => x.id === cur) ? cur : (u[0]?.id ?? null)));
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    setApiUser(userId);
    try {
      if (userId) localStorage.setItem(USER_KEY, userId);
    } catch {
      /* storage unavailable: the picker still works for this tab */
    }
  }, [userId]);

  const user = users.find((u) => u.id === userId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> Engineering Guardrail Copilot
        </div>
        <nav className="tabs">
          {(["review", "history", "standards"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => { setTab(t); setOpenReview(null); }}>
              {t === "review" ? "New review" : t === "history" ? "History" : "Standards"}
            </button>
          ))}
        </nav>
        <label className="identity" title="Demo identity only: this is not authentication.">
          <span>Acting as</span>
          <select value={userId ?? ""} onChange={(e) => setUserId(e.target.value)} disabled={!users.length}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="demo-banner">
        Demo identity: pick who you are acting as. This is <strong>not authentication</strong>; the API trusts the
        selected user.
      </div>
      <main className="content">
        {loadError && <div className="error">Could not load demo users: {loadError}. Has the database been set up (npm run db:setup:local)?</div>}
        {user && tab === "review" && <ReviewPage key={user.id} onOpen={(id) => { setOpenReview(id); setTab("history"); }} />}
        {user && tab === "history" && <HistoryPage key={user.id} openId={openReview} onOpen={setOpenReview} />}
        {user && tab === "standards" && <StandardsPage key={user.id} user={user} />}
      </main>
    </div>
  );
}
