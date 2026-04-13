# Production Checklist

## Vercel Environment Variables

Set these in the Vercel project before the first deployment:

- `PORT`
  Local fallback port for non-Vercel execution. Use `3001` for consistency across contributors.
- `SUPABASE_URL`
  Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`
  Backend-only service role key. Never expose this to the browser or mobile clients.
- `SUPABASE_ANON_KEY`
  Supabase anon key used by the API for login/session exchange.
- `FRONTEND_URL`
  Primary production frontend origin allowed by CORS.
- `ADMIN_SETUP_KEY`
  One-time bootstrap secret required to create the first admin account.
- `NODE_ENV`
  Set to `production` in Vercel.
- `RATE_LIMIT_WINDOW_MS`
  Optional override. Defaults to `900000`.
- `RATE_LIMIT_MAX`
  Optional default fallback limit. Defaults to `100`.
- `WEBHOOK_TIMEOUT_MS`
  Optional outbound webhook timeout override. Defaults to `5000`.
- `CLINIC_ID`
  Optional webhook clinic identifier. Useful for multi-clinic or staging setups.

## First Admin Account

1. Generate a long random `ADMIN_SETUP_KEY` and store it in Vercel.
2. Deploy the API.
3. Send a `POST` request to `/api/auth/register-admin` with:
   - `x-admin-setup-key: <ADMIN_SETUP_KEY>`
   - body containing admin email, password, and name fields accepted by the auth schema
4. Verify the new user exists in Supabase Auth and `user_profiles`.
5. Rotate `ADMIN_SETUP_KEY` immediately after bootstrap if your operational model does not require repeated admin creation.

## n8n API Keys

1. Generate a random key with a clear prefix such as `sk_live_...`.
2. Hash the key with SHA-256 before storing it in the `api_keys.key_hash` column.
3. Store the plaintext key only in n8n credentials or Vercel encrypted environment variables.
4. Assign the role `n8n_agent` or the least-privileged role required for the workflow.
5. Rotate keys quarterly or immediately if any automation host is compromised.

## Supabase Row Level Security

Recommended baseline:

- Enable RLS on `patients`, `doctors`, `appointments`, `feedback`, `waitlist`, and `intake_forms`.
- Create policies so:
  - patients can only read/update their own records through `user_id`
  - doctors can only access appointments and patients tied to their doctor profile
  - receptionists and admins operate through service-role-backed API calls only
- Keep write access to administrative tables such as `audit_logs`, `api_keys`, and `webhook_subscriptions` restricted to the backend.
- Review policies after every schema change and keep them in versioned SQL migrations.

## Backup Strategy

- Enable Supabase point-in-time recovery on production.
- Schedule daily logical backups for critical tables:
  - `patients`
  - `doctors`
  - `appointments`
  - `feedback`
  - `waitlist`
  - `audit_logs`
- Store backups in a separate cloud account or bucket with immutable retention where possible.
- Test restoration monthly in a staging project.

## Monitoring And Alerts

Track these production signals:

- API 5xx rate
  Alert if above `1%` for 5 minutes.
- API p95 latency
  Alert if above `1500ms` for 10 minutes during clinic hours.
- Health endpoint degradation
  Alert immediately on `/health` returning `503`.
- Supabase auth failures
  Alert on unusual spikes in `401` or login failure logs.
- Rate-limit spikes
  Alert if public auth limiter triggers more than `25` times in 15 minutes from the same IP range.
- Webhook delivery failures
  Alert if any subscription fails twice in a row.
- Appointment workflow backlog
  Alert if webhook or automation lag exceeds `5` minutes for reminder or cancellation flows.

## Zero-Downtime Deployment Notes

- Deploy preview builds first and run smoke tests against `/health`, `/api/auth/login`, and one authenticated read endpoint.
- Apply Supabase migrations before or together with the Vercel deployment when schema changes are backward-compatible.
- For breaking DB changes, use expand-migrate-contract:
  - add new columns/tables
  - deploy code that writes both old and new fields
  - backfill
  - remove old fields in a later release
- Keep `ADMIN_SETUP_KEY` and Supabase keys identical across all active production instances during rollout.
