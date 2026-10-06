# 0018. Locations

- Status: Accepted
- Date: 2026-10-06

## Context

Stock lives in places. The pilot shop has a shop floor and a storeroom, and wants to add
warehouses later (product owner, 2026-10-06). Selling devices stand in a shop; a storeroom
never sells. Every stock move needs a place, and a sale made offline needs to know where
its device stands.

## Decision

- **Table `locations`** per tenant: name, kind, default flag, sort order, archive date.
  - `shop` sells and holds stock; `warehouse` (storeroom, depot) only holds stock.
  - The kind is fixed once created (no UPDATE grant), because devices and stock rules
    depend on it. A wrong kind is fixed by archiving and creating a new location.
  - Names are unique among active locations (normalised like catalog names).
- **One default location per tenant**, always an active shop:
  - a partial unique index allows at most one default;
  - a deferred constraint trigger refuses, at commit, a tenant that has active locations
    but no default, so the default can move from one shop to another in one transaction;
  - a CHECK keeps the default a non-archived shop.
- **Devices** (`devices.location_id`) belong to an active shop, checked by trigger. A new
  device takes the default shop unless the admin picks another; `PATCH /devices/:id`
  moves it. A location with active devices cannot be archived.
- **Archiving** a location is refused while any part has a non-zero balance there
  (`stock.has_stock`), while it is the default, or while devices use it.
- **Provisioning** names the default shop (`tenant:create --location-name`), so no
  location name is invented. Existing tenants got a placeholder "Main shop" in the
  migration, which the owner renames.
- **Access**: everyone signed in can list locations (cashiers see quantities in every
  location, product owner 2026-10-06); `locations.manage` creates and changes them.
- `new_uuid_v7()` generates v7 ids in SQL for rows the database itself creates, since
  `uuidv7()` exists only from PostgreSQL 18 and local development runs 16.

## Alternatives considered

- **A location per device or a free-text "bin"**: too fine for a shop with one storeroom,
  and bins can be added later as a level below locations.
- **Making every location sellable**: a storeroom has no till; selling from it would hide
  that stock must move to the shop first.

## Consequences

- Branch-level permissions (who may work in which location) are out of scope; all users
  of a tenant see all its locations.
- Transfers between locations are stock documents (ADR 0020); they never change the
  part's average cost (ADR 0021).
