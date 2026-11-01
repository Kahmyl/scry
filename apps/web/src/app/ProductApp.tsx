import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Landing } from "../features/landing/index.js";
import { isSupabaseConfigured, supabase } from "../infrastructure/auth/index.js";
import { Dashboard } from "./Dashboard.js";

export function ProductApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(isSupabaseConfigured);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    if (!supabase) return;
    const auth = supabase.auth;

    void auth
      .initialize()
      .then(async ({ error: initializationError }) => {
        const result = await auth.getSession();
        return { ...result, error: initializationError ?? result.error };
      })
      .then(({ data, error }) => {
        setSession(data.session);
        if (error) setAuthError("Sign-in could not be completed. Please try again.");
        setCheckingSession(false);
      })
      .catch(() => {
        setAuthError("We couldn’t connect to sign-in. Please try again.");
        setCheckingSession(false);
      });
    const { data } = auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) setAuthError("");
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
      <Route path="/" element={<Landing authError={authError} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
