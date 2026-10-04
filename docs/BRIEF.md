# Product Brief

## Vision

Point-of-sale, inventory and light accounting for car spare-parts shops in markets
with volatile currencies and unreliable internet. Arabic-first, works offline,
multi-currency. Differentiators: search by vehicle, instant alternatives by quality
grade, and dual-currency receivables.

## Segments

Small shop (1-3 users), two-branch shop, wholesaler serving workshops.

## Roles (configurable per tenant)

Cashier (sell only, cannot see cost/margin), Supervisor (all transactions, grants
discounts, approves returns), Owner/Admin, Accountant (optional).

## Packages

- Core (v1): catalog with OEM numbers and basic fitment, inventory, purchasing,
  offline POS, invoices and quotes, customer credit, 2+ currencies, light ledger
  and P&L, roles, backups.
- Plus: special orders, supplier returns (RMA), landed costs, discount grants,
  WhatsApp reminders, price tiers, dead-stock analytics, branches.
- Later: VIN decoding, supplier price-file import, e-invoicing connectors,
  owner mobile app, workshop ordering portal.

## Data model (entities)

- Platform: tenants, users, roles, devices, audit_log, settings
- Catalog: parts, part_numbers, brands, categories, vehicles (type > make > model >
  generation > engine), fitment, interchange, supersession, price_lists, price_tiers
- Parties: customers (class, credit limit), suppliers, supplier_parts
- Inventory: locations, stock_moves, stock_balances, counts, shipments, landed_costs
- Purchasing: purchase_orders, receipts, supplier_bills, supplier_returns
- Sales: quotes, invoices, pos_orders, returns, special_orders, discount_grants
- Payments: payments, allocations, cash_sessions, fx_exchanges
- Accounting: accounts, journal_entries, journal_lines, periods, posting_rules
- Reminders: reminder_rules, templates, send_log

## Acceptance scenarios

1. Search "front pads Camry 2018", then ranked alternatives by quality/price, then sale.
2. Out-of-stock part: show interchange, or create a special order with deposit.
3. Workshop quote with three quality tiers, accepted quote becomes a credit invoice.
4. Supplier invoice receipt: map supplier part numbers to internal SKUs, update cost.
5. Container receipt with freight and customs allocated into cost.
6. Defective part: customer return, supplier RMA, credit-note follow-up.
7. Supersession: replace an old part number, move stock and fitment.
8. Supplier price increase: bulk repricing by margin rules.
9. Monthly dead-stock review.
10. Warranty claim by invoice lookup; period depends on quality grade.
11. Cash sale in currency A; cash sale in currency B.
12. Mixed payment with change in the other currency.
13. Discount via grant, via supervisor PIN, via hand-off to supervisor.
14. Credit sale: limit warning/block, overdue reminder, payment in a different currency
    with FX difference posted.
15. Currency exchange (sell currency B, buy A) with realized gain/loss.
16. Offline: sell, reconnect, sync; duplicate sync; last unit sold on two devices;
    rate change during outage; PIN discount offline.
17. Daily cash close per currency, month-end close with P&L.

## Non-functional targets (to validate)

Local search < 200ms; 8h+ offline selling; RPO ~1h, RTO < 4h; restore drill monthly;
Argon2 passwords, short sessions, role-based access; 58/80mm thermal receipt via
browser printing plus A4 invoice.

## Roadmap (single developer + Claude, indicative)

0 Discovery (2-3w) > 1 Platform: tenants, RLS, auth, settings (3w) >
2 Catalog, inventory, purchasing (5w) > 3 POS and sales (5w) >
4 Ledger, credit, reports (4w) > 5 Pilot with Sky Motors (4-6w) >
6 Productization: onboarding, import tools, billing (4-6w).
Internal alpha after phase 4.

## Open questions

- Country, currencies and tax regime of the first customer (drives functional
  currency, tax templates and e-invoicing needs).
- Real internet reliability at the pilot shop.
