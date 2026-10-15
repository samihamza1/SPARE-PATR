# 0017. Account protection

- Status: Accepted (supersedes parts of ADR 0007 and ADR 0009)
- Date: 2026-10-06

## Context

The review of Sprints 1 to 3 found gaps in the account rules of ADR 0007 and ADR 0009:

- a locked account answered 423 `auth.locked` only for the right password, so the lock
  told an attacker when a guess was right, and attempts during the lock were not counted;
- `POST /me/password` checked the current password without a rate limit, lockout or
  audit, so anyone holding a session could guess it (and make the server run Argon2);
- `users.manage` could grant any role (the owner role to oneself) or set the owner's
  password, and `roles.manage` could add any permission to its own role;
- the absolute session limit was fixed at sign-in, unlike what ADR 0007 states;
- two concurrent admin changes could each pass the last-admin check;
- `TRUST_PROXY=true` let clients choose `request.ip` through `X-Forwarded-For`.

The product owner approved the rules below in the Part 0 plan.

## Decision

- **Lockout** (replaces the lockout part of ADR 0007 "Login hardening"):
  - Every sign-in runs exactly one Argon2 verification (against the stored hash, or a
    dummy one for an unknown shop or user), then one `UPDATE` that locks the user row
    and decides from its current state. Concurrent attempts are therefore counted one
    after another; none can read "unlocked" while another one sets the lock.
  - While the account is locked, every attempt gets the same 401
    `auth.invalid_credentials` as a wrong password, with the same work done, whether the
    password is right or not. `auth.locked` and the 423 answer are gone. The message
    reads "incorrect ..., or the account is temporarily locked".
  - Every failed attempt, including any attempt during a lock, adds one to
    `failed_login_count`. Reaching `security.maxFailedLogins` locks the account until
    now + `security.lockoutMinutes`; an attempt during the lock moves the end to
    now + `lockoutMinutes` again. Only a successful sign-in after the lock has expired,
    or an admin password reset, sets the counter back to zero, so after a lock expires
    the next failure locks again at once.
  - Audit: `auth.login_failed` with reason `unknown_user`, `bad_password` or `locked`,
    and `auth.lockout` for the failure that locks the account. Whether a password tried
    during a lock was right is never recorded.
  - Trade-off: anyone who knows a shop code and a username can keep that account locked
    (lockout denial of service). The per-(IP, shop, username) rate limit and the per-IP
    credential bucket slow this but do not stop an attacker with many addresses. A
    sign-in lock does not end existing sessions. An admin password reset clears the lock
    and the counter (and ends the user's sessions), so an administrator can let a
    locked-out user back in at once.
- **Password change** (`POST /me/password`):
  - It shares the per-IP credential bucket with sign-in and device enrollment (ADR 0007
    addendum) and is limited to 5 requests a minute per user.
  - A wrong current password counts toward the same lockout as sign-in. When that
    failure leaves the account locked, every session of the user is revoked
    (`locked_out`), the caller's included, and the cookie is cleared; the answer stays
    400 `auth.wrong_password`. So whoever holds a stolen session gets at most the
    remaining failed attempts before losing it.
  - Every failure is audited as `user.password_change_failed` with the reason, whether
    the account is now locked, and the client address; never a password. The failure
    that locks the account is also audited as `auth.lockout`.
  - The right current password changes the password even while sign-in is locked (the
    caller holds a session and knows the password); the lock stays until it expires.
    The change applies only if the stored hash is still the one just verified.
- **No privilege escalation** (adds to ADR 0009). Refusals answer 403
  `auth.exceeds_own_permissions`; the actor's permissions are re-read inside the
  transaction; owners hold every permission and are unaffected. An actor may only:
  - grant or revoke a role whose permissions are all among the actor's own;
  - create a role, or change a role's permissions, to a set within the actor's own
    permissions; and change (rename or re-permission) only a role whose current
    permissions are within the actor's own;
  - set the password of, archive, edit, or change the roles of a user whose effective
    permissions are all among the actor's own.
- **Session limits**: both limits come from the tenant's current settings at every
  request: idle against `last_seen_at`, absolute against `created_at + absoluteHours`.
  `expires_at` (the limit at sign-in) stays an upper bound and the cookie expiry. So
  lowering either setting shortens existing sessions, as ADR 0007 intended.
- **Last administrator**: every administrative change to users and roles (role create
  and update, grant, revoke, archive, user edit, admin password reset) first takes
  `pg_advisory_xact_lock` on a fixed namespace and a hash of the tenant id, before any
  check reads permissions or admins. These changes are therefore serialised per tenant,
  and the last-admin check (ADR 0009) and the escalation checks above always see the
  other change committed.
- **`TRUST_PROXY`** (replaces the ADR 0007 addendum bullet): `false` (default), a
  positive number of proxy hops, or a comma-separated list of IP addresses or CIDRs.
  `true` and anything else stop the API at startup with a message. Prefer the address
  list: `X-Forwarded-For` entries are then trusted only while they come from a listed
  proxy. A hop count trusts the nearest hops whatever their address (Fastify 5 alone
  ignores a plain number; the API turns it into a function), so use it only when the
  API port is reachable solely through the proxy. A client address that is not an IP
  (a misconfigured hop count) is stored as null in `sessions.ip`.

## Alternatives considered

- **Always 423 while locked**: no password oracle either, but it tells anyone which
  accounts are under attack; one 401 for every failure keeps a single answer.
- **Resetting the counter when the lock is set or expires**: gives an attacker
  `maxFailedLogins` new guesses per lock period instead of one.
- **`SELECT ... FOR UPDATE`, then `UPDATE`, in application code**: equivalent, but the
  decision would be split across two statements; one statement keeps it in one place.
- **SERIALIZABLE transactions for admin changes**: need retry handling in every route;
  an advisory lock costs nothing at this volume.
- **Documenting `users.manage` and `roles.manage` as owner-equivalent**: rejected; a shop
  wants a manager who can add cashiers without being able to become owner.

## Consequences

- A user locked out by someone else's guesses waits for the lock to expire or asks an
  administrator for a password reset.
- When a module adds a permission, existing owner roles need the data migration ADR 0009
  describes; until then owners cannot grant the new permission either.
- A manager with `users.manage` cannot reset the password of a supervisor who holds
  `audit.read` unless the manager holds it too; such roles must be designed as subsets.
- Admin changes in one tenant wait for each other; other tenants are not affected
  (apart from rare hash collisions, which only add a wait).
- Deployments that used `TRUST_PROXY=true` must switch to the proxy addresses or a hop
  count before upgrading, or the API will not start.
