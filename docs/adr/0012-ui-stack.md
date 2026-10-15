# 0012. UI stack: Mantine, React Router, TanStack Query; Playwright for E2E

- Status: Accepted
- Date: 2026-10-04

## Context

Both web apps are Arabic-first with an English fallback (invariant 8: all text through
i18n, RTL tested). The back office is forms and tables; the POS will be a touch-friendly
PWA. One developer builds both, so the component library must make RTL and common
widgets cheap. Choice of library confirmed by the product owner in the Sprint 2 plan.

## Decision

- **Mantine** for components in both apps. `DirectionProvider` is driven by the i18n
  language, so Mantine's RTL styles switch together with `<html dir>`. System fonts
  (Arabic-capable on every target OS), no web-font download.
- **React Router** (declarative routes) for navigation; **TanStack Query** for server
  state. A 401 from any query clears the signed-in user and returns to sign-in; a
  deliberate sign-out starts the next user at home.
- **API access** goes through one small client: same-origin `/api` (Vite proxy in
  development) so the `SameSite=Strict` session cookie works; error codes from the API
  are translated in the UI (`errors.<code>`), validation issues per field.
- **Permissions in the UI** only shape navigation and pages; the API stays the
  enforcement point (ADR 0007).
- **i18n lint**: `i18next/no-literal-string` checks JSX text and user-facing attributes
  (`label`, `title`, `placeholder`, `description`, `aria-*`); layout and routing
  attributes are not text.
- **Tests**: component tests run in jsdom with a fake API (every page rendered in both
  languages, no leaked keys). **Playwright** runs one end-to-end journey against the real
  API, database and back office in Chromium (owner creates a cashier, grants a role,
  cashier signs in with restricted navigation, language switch flips direction). CI
  installs Chromium; elsewhere `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point to a local one.

## Alternatives considered

- **Tailwind + Radix**: maximum control, but every form control, table and modal is ours
  to build and to make RTL-correct.
- **MUI**: mature, but RTL needs an extra stylis plugin setup and its bundle is heavier
  for the POS.

## Consequences

- The back office bundle is about 780 kB minified (240 kB gzipped), mostly Mantine;
  route-level code splitting can come later. The POS budget is revisited in the POS phase.
- The end-to-end test caught two client bugs (stale user after sign-out, returning the
  next user to the previous user's page) that component tests missed; keep at least one
  journey per major flow.
