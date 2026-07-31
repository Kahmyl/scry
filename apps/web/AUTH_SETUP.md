# Scry authentication setup

1. Create a Supabase project and copy its Project URL and publishable key.
2. Copy `.env.example` to `.env.local` and replace both placeholder values.
3. In Supabase Authentication → URL Configuration, set the Site URL and add local and production redirect URLs.
4. Enable Email authentication.
5. To use OAuth, enable Google and/or GitHub under Authentication → Providers and add the provider credentials requested by Supabase.
6. Add the Supabase callback URL shown on each provider screen to the corresponding Google or GitHub OAuth application.

The browser application restores and refreshes Supabase sessions automatically. The NestJS API must verify the Supabase access token on every protected route before authentication is production-ready. Frontend route gating alone is not an authorization boundary.

## API configuration

Configure the API and MCP process with:

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SCRY_SERVICE_TOKEN=generate-a-long-random-value
```

The API verifies browser JWT signatures against Supabase's JWKS endpoint and validates the `iss`, `aud`, and `exp` claims. First login provisions a local Scry user, personal workspace, and owner membership. All project, run, report, and artifact access is scoped through that workspace.

`SCRY_SERVICE_TOKEN` is for the trusted MCP process only. Never expose it through a `VITE_` variable or ship it to browsers. Run the MCP server with the same value so its API calls authenticate as an internal service.
