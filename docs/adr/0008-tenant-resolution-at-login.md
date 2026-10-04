# 0008. Resolving the tenant at login

- Status: Accepted
- Date: 2026-10-04

## Context

Login happens before any tenant context exists, but `tenants` has FORCE row-level
security, which applies to its owner too. So neither the app role nor a SECURITY DEFINER
function owned by `autoparts_owner` can look a tenant up by slug.

## Decision

- A global table `tenant_directory (tenant_id, slug, archived)`, listed in
  `GLOBAL_TABLES` of the RLS catalog test with a comment. It holds no business data.
- A trigger on `tenants` (insert, slug or archive change) keeps it in sync; it is
  SECURITY DEFINER with a pinned `search_path`.
- The app role has **no** privileges on the table. It can only call
  `resolve_tenant_slug(slug) RETURNS uuid` (SECURITY DEFINER, pinned `search_path`),
  which returns the id of an active tenant or NULL. Unknown and archived slugs are
  indistinguishable, and the table cannot be listed.
- The catalog guard now also fails on any SECURITY DEFINER function without a pinned
  `search_path`.
- The app role may update only `tenants.name`, `default_locale` and `settings`. Changing
  slug, functional currency, time zone or archiving a tenant is an owner-role operation.

## Alternatives considered

- **A BYPASSRLS role owning a lookup function**: works, but adds a role that bypasses
  RLS, which is exactly what invariant 4 tries to avoid.
- **A permissive SELECT policy on `tenants` for slug lookup**: would expose every
  tenant row to the app role and trips the catalog guard (rightly).
- **Subdomain per tenant**: rejected in the Sprint 2 plan (wildcard DNS/TLS, PWA scope);
  it would still need the same lookup.

## Consequences

- Shop codes (slugs) are public identifiers; knowing one only enables a login attempt,
  which is rate limited and audited.
- Provisioning writes the directory implicitly; nothing else writes it.
