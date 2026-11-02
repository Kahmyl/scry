import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { Landing } from "../features/landing/index.js";
import { LegalPage } from "../features/legal/LegalPage.js";
import { SupportPage } from "../features/legal/SupportPage.js";
import { privacyPolicy, termsOfService } from "../features/legal/policies.js";
import { isSupabaseConfigured, supabase } from "../infrastructure/auth/index.js";
import { Dashboard } from "./Dashboard.js";
import { OAuthConsent } from "../features/settings/OAuthConsent.js";
import {
  rememberConnectionReturn,
  takeConnectionReturn,
} from "../features/settings/connection-return.js";

export function ProductApp() {
  return (
    <Routes>
      <Route path="/privacy" element={<LegalPage policy={privacyPolicy} />} />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/terms" element={<LegalPage policy={termsOfService} />} />
      <Route path="*" element={<AccountApp />} />
    </Routes>
  );
}

function AccountApp() {
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
        <Route path="/" element={<SignInReturn />} />
        <Route path="/connect/authorize/:uid" element={<OAuthConsent />} />
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
      <Route path="/connect/authorize/:uid" element={<ConnectionSignIn authError={authError} />} />
      <Route path="/" element={<Landing authError={authError} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ConnectionSignIn({ authError }: { authError: string }) {
  const { pathname } = useLocation();
  useEffect(() => {
    rememberConnectionReturn(pathname);
  }, [pathname]);
  return <Landing authError={authError} initialSignIn />;
}
function SignInReturn() {
  const [target] = useState(takeConnectionReturn);
  return <Navigate to={target} replace />;
}
