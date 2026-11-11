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

## 2026-11-10: scope check with Payload's multi-tenant plugin (K443)

The eighth audit left this untried: every scope test added `tenant` by hand with `overrides`. `test/multi-tenant.test.ts` runs Kitting with `@payloadcms/plugin-multi-tenant` 3.92.1 (a devDependency, at the same version as `payload`) adding the field, on its own in-memory MongoDB databases. Kitting goes first in `plugins`, the tenant plugin second, as the tenant plugin asks.

### Gap added (7 tests)

- **Startup refuses** when one Kitting collection (`kitting-settings`) is left out of the tenant plugin's `collections`, with Kitting's message naming it.
- **Startup refuses** when the tenant plugin runs before Kitting. Payload's own config check stops it first, with "Field tenant was not found" (the units' unique `externalId` + `tenant` index), so Kitting's message never shows. The tenant plugin logs a warning naming every Kitting collection it couldn't find. It still fails closed.
- **Startup goes ahead** with every Kitting collection listed, and each has the tenant plugin's own field: a single relationship to `tenants`, indexed.
- **Per-site rules through the real field:** a recipe or item can't use another site's supply or supplier; recipe keys are unique per site; `applyRecipe` refuses another site's recipe.
- **A movement takes its supply's site,** when given none, when given the wrong one, and when written by staff with `overrideAccess: false`.
- **`assignUnits` and `buildUnits` with `assignTo` stay inside one site:** site B keeps a unit for an order; site A's order of the same name holds nothing, so building into it is refused with `nothingReserved` and writes no unit or movement. Site A's own queued order is filled on site A, and the same external ID can be used once on each site.
- **With the tenant plugin's access, Kitting's default access and `overrideAccess: false`:** site A's staff see only site A's items, suppliers, movements, recipes, units and build requests, and site B's staff only B's. Site A's staff can't read B's rows by ID, create a recipe on B, record a movement on B's supply, or rename B's supply, and B's stock is unchanged. Kitting's functions refuse B's recipe for site A (`applyRecipe`, `buildUnits`), and don't find B's recipe key or unit from site A.

79 tests.

### Found (no bug)

- The tenant plugin's field isn't `required`; its own `validate` refuses an empty value. Kitting sets a movement's and a lot's site in `beforeChange`, which runs before field validation, so that works.
- With Kitting's default `access` (any signed-in user), Kitting's own "can manage this supply" check passes for another site's supply, because it reads Kitting's `access.manage`, not the tenant plugin's wrapped access. The tenant plugin is what refuses the movement: Kitting gives it the supply's site, and the tenant field rejects a site the user isn't in. That matches the README ("keeping each site's records to its own site is your tenant plugin's job"), and the test now proves it.

### Skipped, and why

- **The admin panel's tenant selector and cookie:** UI, outside the Local API. It belongs with the platform check in a real host.
- **The tenant plugin's own internals** (its users array, tenant clean-up on delete): its tests, not Kitting's.

## 2026-11-10, seventh audit: the Shipping adapter

The docs pass found that a site passing the Shipping plugin got no carrier rates: Kitting asked for `quoteRates`, Shipping offers `quote`, and the failure fell back to postage rates with nothing to show for it. That's a fail-closed check that said nothing, so it's covered now.

83 tests (4 new, 1 extended).

### Gaps added

- **Shipping's `quote` through `ratesFromShipping`:** a made-up `quote` of Shipping's exact shape gives carrier-priced suggestions; one quote per distinct parcel, converted to inches and ounces and rounded up; a box that couldn't be quoted is left unrated with a note; when nothing could be quoted the error is passed on; no rates (and the reason) without a destination, outside the US, or with nowhere to ship from.
- **Fallback is visible:** a throwing provider and one of the wrong shape (no `quoteRates`, or no `rates` list) fall back to postage rates, return `fallback`, mark every summary, and log the error's name once, never its message.
- **Startup refusal:** a `shipping.provider` without `quoteRates` stops startup with a message pointing to the adapter; the adapter itself is accepted.
- Mutation-checked: removing the startup refusal, the shape guard, the rates-list check, the log-once, the fallback mark or the adapter's rethrow each fails a test.

### Skipped, and why

- **The startup warning for a provider another plugin registered:** it's a log line with no effect; the runtime fallback it warns about is tested.
- **Shipping's real `quote` against EasyPost:** Shipping's own tests cover it. A type check against Shipping's source confirmed its `quote` fits the adapter's type; Kitting's tests use a made-up function of that shape.

## 2026-11-11, only an exact `true`, or a query that is applied

Suite: 83 tests before, 85 after (`npx vitest run`). From an access sweep.

- **The change.** `src/access.ts`: `exactlyTrue`, `isWhere` (a well-formed, non-empty query of `and`/`or` lists and known operators), `trueOrWhere` and `mayUse`; a throw is always a no. `restockArrivals` took any truthy `manage` answer, so a site-scoped query showed Restock's arrivals from every site. A query can't be applied to Restock's orders from here (Restock's `arrived` returns no site), so it now needs an exact `true`, and anything else, a query included, gets nothing without asking Restock. The overview, count, build and getting-started views read `read` and `manage` as truthy; they now use `mayUse`: `true` or a well-formed query (which their reads apply, since they don't override access), and nothing else.
- **Tests.** In `kitting.test.ts`, "shows them only to people who manage every site…": staff with a site query get nothing and Restock isn't asked; someone answered `true` gets the list; `1`, `'yes'`, `{}`, `{ tenant: false }`, a throw and a rejection get nothing. The old expectation that site-scoped staff see the list was changed on purpose. New `views.test.ts` (Payload's admin shell and UI kit stubbed, a made-up Payload that reads nothing, the stock report stubbed): count, build and setup show their refusal and read nothing for those six answers, and read for `true` and a site query; the overview refuses on the same answers from `read`, and runs its manager-only reads only when `manage` says `true` or a query.
- **Mutation checks.** 11 mutations, each a Python string replace restored byte for byte (SHA-256 checked). All 11 fail the suite: truthy passing and errors rethrown in the helpers; `isWhere` taking any object; `trueOrWhere` passing truthy answers; the old truthy check put back at the arrivals, count, build, setup, overview `manage` and overview `read`.
- **For the lead.** Site-scoped staff no longer see the arrivals line on Today. Showing it to them safely needs Restock's `arrived` to return each order's site (its internal list has it), so Kitting can keep only the sites the query allows. That's a change to the crossing contract, in both repos.
- **Skipped.** The views are checked through their element trees and the reads they make, not rendered in a real admin.

## 2026-11-11, Restock's arrivals for staff limited to some sites

Suite: 85 tests before, 89 after (`npx vitest run`). Follows the "For the lead" note above; Restock's `arrived` now returns each order's site (`scope`).

- **The change.** `src/access.ts`: `sitesAllowed(where, scopeField)` reads a query as a set of site IDs when it names nothing but the scope field, with `equals` or `in` on string or number IDs, alone or under `and` (every part) or `or` (any part); several keys in one object must all hold. Anything else is `null`. `restockArrivals` takes `trueOrWhere`'s answer: `true` shows every order, a query `sitesAllowed` can read keeps the orders whose `scope` is in it, and anything else, an unreadable query included, shows nothing without asking Restock. An order whose `scope` isn't a string or number ID (missing, `null`, an object) never matches. The unused `exactlyTrue` was removed.
- **Tests.** In `units.test.ts`, two pure tests: the shapes read as sites, and 26 shapes that must be `null` (other fields and operators, `tenant.id`, null, empty, object and NaN IDs, `in` with a non-list or a null, mixed `and`/`or`, no scope field). In `kitting.test.ts`, the arrivals test is split: "every site's to an exact true" (as before, now with two sites' orders), and "staff limited to some sites": site A's staff see site A's orders and not B's, B's see B's, a populated site counts, orders without a site never show (even for a query naming `'null'`), and 14 unreadable queries show nothing without asking Restock. In `multi-tenant.test.ts`, with Kitting's `manage` built from the multi-tenant plugin's own `getTenantAccess`: site A's staff see A's, staff of both sites see both, staff of no site see nothing, an admin sees both.
- **Mutation checks.** 16 mutations, each a Python string replace restored byte for byte (SHA-256 checked). All 16 fail the suite: the old truthy `manage` check; an unreadable query let through; the site filter skipped for a query; the order-site type check removed; `isWhere` dropped from `sitesAllowed`; an unreadable `and`/`or` part ignored; `or` read as `and`; other fields accepted; several operators accepted; `equals` taking any value; `in` taking any values, or a non-list; empty-string and NaN IDs accepted; keys in one object not intersected. A first version also checked `site !== null` before the type check; it survived, because `typeof null` is `'object'`, so it was replaced by an explicit string-or-number check, which is killed.
- **Skipped.** The real Restock isn't installed in Kitting's tests (Kitting doesn't depend on it, D2), so `arrived` is made up in Restock's shape; Restock's own tests check what it returns. The Today line isn't rendered in a real admin.
