# 0011. Device enrollment and offline PIN (design)

- Status: Accepted (enrollment implemented; offline PIN is a design for the POS phase)
- Date: 2026-10-04

## Context

Selling must continue offline (CLAUDE.md), and the BRIEF scenario 16 includes a PIN
discount while offline. A POS terminal therefore needs an identity of its own, and
cashiers and supervisors must be able to authenticate on it without the server. The
Sprint 2 plan implements device enrollment now and defers offline login to the POS phase.

## Decision — implemented now

- An admin (`devices.manage`) creates a device and receives a one-time enrollment code:
  10 Crockford base32 symbols (50 bits), shown as `XXXXX-XXXXX`, valid 30 minutes.
  Typing is forgiving (case, spaces, dashes, O/0, I/L/1).
- The device calls `POST /devices/enroll` with the shop code and the code (rate limited)
  and receives a 256-bit credential, which it stores. Only SHA-256 hashes of code and
  credential are kept; the code is single-use.
- Login may send `X-Device-Credential`; a valid one binds the session to the device.
  Revoking a device ends its sessions.

## Decision — design for the POS phase

- **Offline verifiers**: on sync, an enrolled device receives, for each user allowed to
  work offline on it, an Argon2id verifier of that user's PIN (never the password), with
  a parameter set chosen for the target hardware. Verifiers are stored encrypted with a
  key derived from the device credential, refreshed on every sync, and wiped when the
  device is revoked or the user is archived.
- **Unlock**: a cashier unlocks the POS with the PIN against the local verifier. Failed
  attempts are counted locally and lock the user on that device.
- **Supervisor PIN offline** (discounts, credit-sale approval): verified locally the
  same way; the approval is recorded in the outbox with user, device and time, and
  uploaded for audit on reconnect, where it appears as a normal audit entry flagged
  `offline`.
- **Limits**: a maximum offline window per tenant (setting), after which the device
  requires a fresh online login.

## Alternatives considered

- **Shared terminal password**: no per-user accountability, which the audit rules need.
- **Caching password hashes on devices**: exposes the online credential to offline
  brute force; a separate PIN verifier limits the damage to POS actions.

## Consequences

- Lost or stolen devices are handled by revocation; until the device next syncs, its
  local verifiers remain usable offline, bounded by the offline window.
- The POS phase needs: PIN set/reset endpoints, the verifier sync payload, local
  lockout, and the outbox entries for offline approvals.
