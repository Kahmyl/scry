import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { Landing } from "../features/landing/index.js";
import { LegalPage } from "../features/legal/LegalPage.js";
import { SupportPage } from "../features/legal/SupportPage.js";
import { privacyPolicy, termsOfService } from "../features/legal/policies.js";
import {
  initialPasswordRecovery,
  isSupabaseConfigured,
  supabase,
} from "../infrastructure/auth/index.js";
import { PasswordRecovery, PasswordResetRequest } from "../features/landing/PasswordRecovery.js";
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
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(isSupabaseConfigured);
  const [authError, setAuthError] = useState("");
  const [recoveringPassword, setRecoveringPassword] = useState(initialPasswordRecovery);
  const [recoveryFailed, setRecoveryFailed] = useState(false);

  useEffect(() => {
    if (location.pathname === "/reset-password") setRecoveringPassword(false);
  }, [location.pathname, recoveringPassword]);

  useEffect(() => {
    if (!supabase) return;
    const auth = supabase.auth;
    let active = true;
    let initialized = false;

    void auth
      .initialize()
      .then(async ({ error: initializationError }) => {
        const result = await auth.getSession();
        return { ...result, error: initializationError ?? result.error };
      })
      .then(({ data, error }) => {
        if (!active) return;
        initialized = true;
        setSession(data.session);
        setRecoveryFailed(Boolean(error));
        if (error) setAuthError("Sign-in could not be completed. Please try again.");
        setCheckingSession(false);
      })
      .catch(() => {
        if (!active) return;
        initialized = true;
        setRecoveryFailed(true);
        setAuthError("We couldn’t connect to sign-in. Please try again.");
        setCheckingSession(false);
      });
    const { data } = auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") {
        setRecoveringPassword(true);
        setRecoveryFailed(false);
      }
      if (nextSession) setAuthError("");
      if (initialized) setCheckingSession(false);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (checkingSession) {
    return (
      <div className="auth-boot">
        <span className="auth-orbit" />
        <small>RESTORING SECURE SESSION</small>
      </div>
    );
  }

  if (recoveringPassword && location.pathname !== "/reset-password") {
    return <Navigate to="/reset-password" replace />;
  }
  if (location.pathname === "/forgot-password") return <PasswordResetRequest />;
  if (location.pathname === "/reset-password") {
    return (
      <PasswordRecovery
        key={session?.user.id ?? "signed-out"}
        session={session}
        authError={recoveryFailed ? "Recovery could not be completed." : authError}
        onComplete={() => {
          setRecoveringPassword(false);
          navigate("/dashboard", { replace: true });
        }}
      />
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
