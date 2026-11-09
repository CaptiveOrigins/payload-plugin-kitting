# Test audit

Each audit maps what the plugin promises (README, docs/decisions.md) to the tests that prove it, then lists the gaps added and the gaps skipped, with the reason. Rule: `~/Code/CLAUDE.md`, "Test self-audits".

## 2026-11-08, first audit (after layers 1 and 2 and the stock methods)

49 tests: 18 pure (`test/units.test.ts`, `test/stocklevel.test.ts`, `test/contracts.test.ts`) and 31 against an in-memory MongoDB replica set (`test/kitting.test.ts`).

### Covered

| Promise | Tests |
|---|---|
| On hand always equals the sum of an append-only log; who is recorded | movements: keeps on hand equal…, never lets on hand be set by hand |
| Movements can't be edited or deleted, even with access overridden | movements: refuses to edit or delete… |
| Never below zero by default, naming every shortage, writing nothing; `warn` goes through | movements: refuses a movement…; recipes: refuses when anything would go negative…, goes below zero… |
| Stock joins the caller's transaction and rolls back with it | recipes: rolls back with the caller's transaction |
| Low-stock email fires once per drop, never twice, not when email is off, and once when two senders race | low-stock email (5 tests) |
| **Site isolation**: items, movements, recipes, lots and built units stay in their site; no cross-site links | sites and access: keeps each site's stock to itself; audit: keeps lots and built units to their own site; nested recipes (cross-site sub-recipe refused); builder (same ID on another site allowed) |
| **Access**: staff write, viewers read, nobody else in, including lots, units and both HTTP endpoints | sites and access: lets staff write…; audit: lots and units, void over HTTP; builder: builds over HTTP only… |
| Units and packs convert once; the wrong kind is refused, in movements and recipes | units (pure); units and the shrinkage allowance: takes stock in packs…; audit: a recipe unit that can't convert |
| Shrinkage allowance: most specific wins, recorded per movement, switched off globally; the learned % and its minimum history | shrinkage allowance (pure); adds the allowance…; suggests an allowance… |
| Lots: first to expire first, expired never used, every use on a lot, write-off once, lots not editable or duplicated by hand, overview lists what to use soon | lots (pure); lots: first to expire first…; audit: writes an expired lot off once |
| Nested recipes scale by what they make; a recipe can't use itself | nested recipes |
| Builder: one unit per ID with its lots; refuses repeats, used IDs, oversize batches, short stock, a host refusal; writes nothing when refused; one winner when two builds race for an ID; units not made, changed or deleted by hand; void with or without return to the same lots | the builder (5 tests); audit: refuses a build without enough stock, only one of two builds… |
| **Stock maths**: z, weighted mean and deviation, Holt, daily demand, each of the five methods against hand-worked values, the fallback, the batch cap, the comparison | stocklevel (10 pure); builder: recommends ready stock… |
| Commerce and shipping contracts | contracts (2, with made-up doubles) |

### Gaps added in this audit (5 tests, 1 fix)

- Lots and built units: site isolation, viewer read-only, no anonymous access. **This found a real gap:** staff of one site could create a lot on another site's supply, because a lot takes its site from its supply. Lots now check the person may manage that supply, as movements already did.
- `POST /api/kitting/void` access: signed out, another site's staff and a viewer are refused, and nothing changes.
- A build without enough stock is refused and writes no movements and no units.
- Two builds at once with the same ID: exactly one succeeds, and the loser takes nothing off stock. Built units now also have a unique database index on ID and site.
- `writeOffExpired` run twice writes off once. A recipe line in a unit that can't convert is refused.

### Gaps skipped, and why

- **The admin pages** (overview, builder form, nav link) aren't rendered in tests. They need a full Next and Payload admin, and their logic (`stockReport`, `buildUnits`, the endpoints) is tested directly. They're covered by the owner's hands-on test T14 (keyboard and VoiceOver included) and a browser check before the first npm publish. This is on the lead's list.
- **Two receipts at once with the same new lot number:** both would update the same supply, so MongoDB's write conflict aborts one. A unique index would also reject lots without a number, and they are allowed. Not worth a slow race test.
- **Admin field conditions and descriptions:** these are framework rendering, so skipped as overkill.
- **The email layout** (`defaultAlertEmail` HTML): the text is checked through the alert tests. The HTML is escaped by one small function, and the layout is cosmetic.
- **Commerce and shipping with a real shop or carrier:** none is built yet. The contracts are tested with doubles, and integration tests come with level 3.

## 2026-11-08, second audit (after level 3, the platform wiring and a browser check)

60 tests: 20 pure, 39 against an in-memory replica set, and 1 with Payload's real ecommerce plugin (`test/ecommerce.test.ts`).

### New promises and their tests

| Promise | Tests |
|---|---|
| Assign ready units oldest first, queue the rest, idempotent per reference; builds fill requests first | fulfilment: assigns ready units… |
| The scan at packing decides: fill a waiting place, else swap a held unit; refuse another order's or a held-nothing order | fulfilment: lets the scan at packing decide… |
| Release one or all (requests cancelled), never shipped units; requests not made by hand | fulfilment: releases one unit… |
| **Site isolation** for orders: another site can't reach units, recipes or references | fulfilment: keeps one site's orders away… |
| Ready-stock states by the owner's rules, one email per change, none back to OK, not sent when email is off, not settable by hand | ready-stock states (2) |
| Box suggestions: packings within weight limits, postage bands, ranking, carrier rates, carrier failure falls back and says so, other sites' boxes never offered | packing (pure); box suggestions |
| Ecommerce: availability follows ready units, orders fill or queue once, cancellation releases, skipped orders untouched | with Payload's ecommerce plugin |
| **Access**: accepting a number to keep is for people who manage that recipe, whole numbers only | accepting a suggested number to keep |
| A host collection is never replaced by one of Kitting's | plugin set-up |

### Found and fixed

- **The builder page showed the overview.** `/admin/supplies` matched `/admin/supplies/build`. Only a browser check could catch this; the views are now exact.
- **Kitting replaced a host collection with the same slug.** On the platform, that was the Kits area's own `box-types`. It now refuses at startup, with a test.
- **Startup failed without `scopeField`.** The unique ID index clashed with the field index. The ecommerce test, which has no sites, caught it.

### Skipped, and why

- **Two packers scanning the same unit at the same moment.** Both write the same unit document, so MongoDB aborts one with a write conflict; the Kits side retries once, then asks to try again. A reliable race test would be slow and flaky.
- **Screen reader.** That's the owner's test T14. The keyboard-only flow was checked in a browser.
- **Payments in the ecommerce test.** Kitting only reads orders, so payments are out of scope.
