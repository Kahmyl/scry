-- This runs on the Supabase identity project, NOT on Scry's application database.
-- GET /rest/v1/rpc/scry_auth_healthcheck performs a real, read-only database query.
-- It deliberately reads no tables and exposes no account or application data.
CREATE OR REPLACE FUNCTION public.scry_auth_healthcheck()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION public.scry_auth_healthcheck() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scry_auth_healthcheck() TO anon, authenticated;
