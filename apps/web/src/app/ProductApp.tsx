import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Landing } from "../features/landing/index.js";
import { isSupabaseConfigured, supabase } from "../infrastructure/auth/index.js";
import { App as Dashboard } from "./App.js";

export function ProductApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return;

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setCheckingSession(false);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  if (checkingSession) {
    return (
      <div className="auth-boot">
        <span className="auth-orbit" />
        <small>RESTORING SECURE SESSION</small>
      </div>
    );
  }

  if (session) {
    return (
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/dashboard/*"
          element={
            <Dashboard
              userEmail={session.user.email ?? ""}
              onSignOut={async () => {
                await supabase?.auth.signOut();
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
