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

## 2026-11-09, third audit (after getting started, stock count and Today)

65 tests: 20 pure, 44 against an in-memory replica set, and 1 with Payload's real ecommerce plugin.

### New promises and their tests

| Promise | Tests |
|---|---|
| A count records each difference once and leaves matches alone. With lots, a shortfall comes off expired lots, then the first to expire; extra goes into the newest lot | stock count: records each difference… |
| Bad counts (negative, not a number, a supply twice, none at all) are refused, and nothing is written | stock count: refuses bad counts… |
| **Access**: counting over HTTP needs a signed-in person who may manage every supply in the count. One supply from another site refuses the whole count, and an empty box is never read as zero | stock count: counts over HTTP… |
| Getting-started progress follows what the person can see | stock count: tracks the getting-started steps… |

### Checked in a browser, not in tests

The setup page, the count page (keyboard only, with an invalid box blocking Save) and the Today summary, in a local dev server of the host app with made-up data. Rendering them in tests needs the full Next admin, so it's skipped, as before.

## 2026-11-09, fourth audit (shrinkage in the admin, branch shrinkage-admin)

66 tests. Added: shrinkage settings per site. A site switches it off or changes its default, and other sites are unaffected. There's one set of settings per site. A viewer can't create them and another site's staff can't change them. Nobody reads them without signing in.

Checked in a browser, with made-up data: the settings page, and the learned suggestion on a supply's page with its reasoning. "Use 10.3%" saved when pressed with the keyboard and when clicked by a script. Twice, a mouse click from the in-app browser pane didn't reach the button. A real mouse click from Playwright (`page.click()` with `trial: false`) did save it, 2% to 10.3%. At the button's centre, `elementFromPoint` returns the button itself, and its `pointer-events` is `auto`. So the in-app browser pane was at fault, not the page. The owner's hands-on test T14 still includes a mouse click.

Skipped: rendering the supply page's suggestion in tests, which needs the full admin, as before.

## 2026-11-09, `restockNeeds` (crossing `kitting-restock`)

67 tests. Added "what to buy, for Restock": it covers below-level and ready-stock needs, the larger of the two, the reason given, site isolation (another site's shortage never shows) and a site required. It's read-only, so there are no access paths to test: callers pass their own `req` and run with their own checks.

## 2026-11-10, fifth audit (after 0.2.0)

68 tests. Mapped the 0.2.0 CHANGELOG to the tests. Everything was covered except Restock's arrivals on Today, which lived inside the admin view.

### Gap added (1 test, 1 fix)

- **Access:** the arrivals line is only for people who may manage supplies. It's now `restockArrivals`, tested: nothing for a viewer or a signed-out person, and Restock isn't even asked; staff get the list, asked as themselves; no list without Restock.
- **Fails closed, visibly:** if Restock throws, Today loads without the line. Before, the error was swallowed with no log; it's logged now.

### Skipped, and why

- **Site isolation of the arrivals:** Restock filters them by what the person may receive, and that's tested in Restock (`awaitingConfirmation` with a user). Kitting passes the person through unchanged, which the new test checks.
- **Rendering the Today line:** needs the full admin, as before. It was checked in a browser on 2026-11-09.

### Added the same day: partial carrier rates (crossing `kitting-shipping`)

Kits' shipping provider (draft platform PR #61) prices a box as outbound plus one return label, and returns no rates without a key or a destination. Before this, a carrier that priced only some packings was ranked in one list with packings priced from postage rates, so a partly priced packing could look cheaper than it was. The box suggestion test now covers a carrier that prices some boxes (carrier-priced packings first, with a note) and one that prices none (postage rates, with its reason).


## 2026-11-10, sixth audit: the scope field check

Restock's move to Kitting 0.2.0 found that a scoped site which skips `kitting-settings` in its tenant plugin gets "the following path cannot be queried: tenant" from the first stock report. That's an access rule (sites must never mix), so it's checked in code now.

### Gap added (2 tests, 1 fix)

- **Startup stops** when a Kitting collection lacks the scope field, naming each one, before the host's own `onInit` (`test/scope.test.ts`).
- **Startup goes ahead** when every collection has it, and when there's no scope field, and the host's `onInit` still runs.

70 tests. Nothing skipped.

## 2026-11-10, seventh audit: build at packing (`assignTo`)

### Gap added (1 test)

- `buildUnits` with `assignTo`: the order's waiting request beats an older request; with nothing waiting, it takes a kept unit's place, and the freed unit fills another waiting request; an order holding nothing is refused with `nothingReserved`, and nothing is written.

71 tests. Nothing skipped.

## 2026-11-10, eighth audit (fortnightly pass over what landed since the fifth)

Since the fifth audit: the scope field check (9662ca0), `buildUnits`' `assignTo` (f2b614c), and docs only (the station design, the decision feed, the roadmap). The sixth and seventh audits added tests with each change; this pass checks them against the README, the CHANGELOG and `docs/decisions.md`.

### Covered

| Promise | Tests |
|---|---|
| **Fails closed:** with a scope field, startup stops when any Kitting collection lacks it, naming each, before the host's `onInit` | scope field check: stops startup… |
| It starts, and runs the host's `onInit`, when every collection has the field and when there's no scope field | scope field check: starts when… |
| `assignTo`: the order's waiting request first, over an older one; else a kept unit's place, and the freed unit fills another waiting request; `assigned` says which went where | fulfilment: builds at packing straight into one order… |
| `assignTo` on an order holding nothing is refused with `nothingReserved`, and no unit is written | the same test |

### Gap added (1 test)

- **Site isolation and writing nothing, for `assignTo`:** site B keeps a unit for an order, and site A builds for an order of the same name, which holds nothing on site A. The build is refused with `nothingReserved`, and a blank order name with `reference`. Neither writes a unit or a stock movement, and site B's unit stays kept for its order. The seventh audit's test checked units but not movements, and didn't cross sites.

72 tests.

### Found, not fixed (for the lead)

- **`assignTo` and an order whose units have all shipped.** `assignBuilt` refuses only when the order holds no units at all, and it counts shipped units as held. So an order with only shipped units isn't refused: the build goes ahead, `assigned` is empty, and the new unit goes to another waiting request or stays ready. `swapUnit` refuses the same order with `nothingReserved`. The packing station could take a successful build to mean the unit went to the order. Either refuse it as `swapUnit` does, or document it and have the station check `assigned`. Not tested here, because the right behavior is the lead's call.

### Skipped, and why

- **`assignTo` access by role:** `buildUnits` runs the order lookup with the caller's `req`, and the builder's access (viewer, other site, signed out) is tested already. `POST /api/kitting/build` doesn't take `assignTo`, so there's no new HTTP path.
- **The scope check's singular wording** ("has" for one collection): cosmetic.
- **A real host with Payload's multi-tenant plugin adding the field:** still untested, as 9662ca0 says. The test adds the field by hand with `overrides`, which is what the check reads. On the lead's list for the next platform check.
- **Docs-only commits:** nothing to test.

Lead's follow-up (2026-11-10): the bug above is fixed. `assignTo` counts only units still kept, not shipped ones, as `swapUnit` does. The assignTo test now covers an order whose units have all shipped, and putting the old check back fails it.
