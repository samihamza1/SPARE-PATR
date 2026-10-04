# 0007. Authentication and sessions

- Status: Accepted
- Date: 2026-10-04

## Context

The BRIEF requires Argon2 passwords, short sessions and role-based access. Users belong
to one tenant and log in with a shop code, a username and a password (decided in the
Sprint 2 plan). Both web apps are browser apps; the POS also runs on enrolled devices
(ADR 0011). Session limits are tenant settings; the agreed defaults are 30 minutes idle
and 12 hours absolute.

## Decision

- **Passwords**: Argon2id (`@node-rs/argon2`) with the OWASP baseline m = 19 MiB,
  t = 2, p = 1 (pinned by a unit test). Policy: 10 to 128 characters, no composition
  rules, a small deny-list of common passwords (NIST SP 800-63B).
- **Server-side sessions** in `sessions` (tenant table). The cookie `sid` holds
  `<tenant_id>.<session_id>.<secret>`; the secret is 32 random bytes and only its SHA-256
  is stored. The tenant id in the token sets the RLS context for the lookup, so a token
  can never resolve outside its tenant. Sessions are revoked, never deleted.
- **Cookie**: `HttpOnly`, `Secure` (configurable off for plain-http development only),
  `SameSite=Strict`, `Path=/`, expiring at the absolute limit.
- **Expiry**: idle limit checked against `last_seen_at` (written at most once a minute),
  absolute limit stored as `expires_at`. Both from tenant settings at check time, so a
  shorter setting applies to existing sessions.
- **Revocation**: logout; password change (other sessions); admin password reset,
  user archive and device revocation (all sessions of that user/device).
- **Login hardening**: unknown shop, unknown user and wrong password give the same
  401 `auth.invalid_credentials`, and a dummy Argon2 verification keeps timing similar.
  After `security.maxFailedLogins` (default 5) failures the account locks for
  `security.lockoutMinutes` (default 15). A locked account answers 423 `auth.locked`
  only when the correct password is given. Rate limit: 10 attempts per minute per
  (IP, shop, username); device enrollment likewise per (IP, shop).
- **CSRF**: on top of SameSite=Strict, any POST/PUT/PATCH/DELETE carrying the session
  cookie must send an `Origin` in `ALLOWED_ORIGINS`.
- **Access control**: every route declares `config.access` as `public`,
  `authenticated` or a permission code; the server refuses to start otherwise. A test
  calls every route anonymously (expects 401) and as a user without permissions
  (expects 403). Permissions are re-read on every request, so role changes apply at once.
- **Audit**: `auth.login`, `auth.login_failed`, `auth.lockout`, `auth.logout`,
  `user.password_change` and all administrative changes go to `audit_log` in the same
  transaction as the change.

## Alternatives considered

- **JWT access tokens**: stateless, but cannot be revoked immediately (archive, device
  loss, password reset) without a server-side deny-list, which is a session table again.
- **Tokens in localStorage / Authorization header**: readable by any XSS; an httpOnly
  cookie is not.
- **bcrypt / scrypt**: Argon2id is the current OWASP first choice and what the BRIEF names.

## Consequences

- One indexed lookup per request (session + user + tenant + roles) inside the tenant
  transaction.
- Behind a reverse proxy, `trustProxy` must be configured so rate limits and audit see
  the client address (`TRUST_PROXY`, see the addendum).
- MFA, password reset by e-mail and offline PIN unlock are not covered here (ADR 0011
  for offline).

## Addendum (2026-10-04, Sprint 3 review)

These additions tighten the decision above without changing it.

- **Per-IP limit on credential endpoints**: `/auth/login` and `/devices/enroll` share
  one bucket per client IP (30 requests a minute by default). It sits on top of the
  per-account limits. Without it, one address could spray many usernames and make the
  server run Argon2 without bound.
- **`TRUST_PROXY`** (API environment) sets Fastify's `trustProxy`. It accepts `true`, a
  number of proxy hops, or a list of addresses or CIDRs. It is unset (no proxy) by
  default. It must be set behind a reverse proxy, or every client shares the proxy's
  address in rate limits and audit entries.
- **Rate-limit store**: kept in process memory, so limits apply per API instance. When
  more than one instance runs, move the store to Redis (`@fastify/rate-limit` supports
  it).
