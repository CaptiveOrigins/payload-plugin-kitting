# Changelog

## 0.2.1 (2026-11-10)

- **`restockArrivals(payload, { req })`:** Restock's "Arrived, please confirm" orders for the Today line, now a tested function instead of code inside the admin view. It's empty for anyone who can't manage supplies (Restock isn't asked), and when Restock fails, Today still loads without that line and the error is logged. Before this, a Restock failure was swallowed with no log.

- **Box suggestions with a carrier that prices only some boxes:** packings it priced now come first, then the rest, each by cost, with a note. A carrier's price (which may include a return label) and your postage rates aren't comparable, so they're no longer ranked in one list. A carrier that gives no rates at all now says so plainly, instead of asking whether box sizes are set.

- **A missing scope field stops startup, with a plain message.** With `scopeField` set, every Kitting collection must have that field once all plugins have run. One without it (for example `kitting-settings` left out of a tenant plugin after upgrading to 0.2) used to fail later with "the following path cannot be queried". Now startup stops and says which collections and how to fix it, before your own `onInit` runs.

Tested: 70 tests (3 new, 1 extended).

## 0.2.0 (2026-11-09)

**Upgrading from 0.1.0:** there's one new collection, `kitting-settings` (one per site). If you use a tenant plugin, add it to your site-owned collections next to Kitting's others, and build its indexes before first use. Nothing else changes for existing data.

- **Getting started** at `/admin/supplies/setup`: three plain steps (your supplies, what you make, a first count), each showing how far you've got.
- **Stock count** at `/admin/supplies/count` and `POST /api/kitting/count`: type what's on the shelf, and each difference becomes one adjustment. For lots, expired stock goes first, then the soonest to expire. Extras go into the newest lot. An empty box is never read as zero, and the whole count is refused if any supply isn't yours to manage.
- **Today** at the top of the supplies overview: what to buy, what to build and what to use soon. With Restock installed, it also lists deliveries that have arrived and wait for someone to confirm them. Kitting reads that through `config.custom.restock`, so it still doesn't depend on Restock, and a delivery never adds stock.
- **Shrinkage in the admin:**
  - Each site turns its allowance on or off and sets its default in Kitting settings. The plugin's options are now only the starting values.
  - Each supply's page shows the shrinkage learned from the last 90 days, with its reasoning, and a "Use N%" button that changes nothing until it's pressed.
- **`restockNeeds(payload, { scope, req })`:** what to buy, per supply, with the reason. It takes the larger of two amounts: the reorder suggestion when stock is below its level, and what building recipes up to their target would need. Usable stock is subtracted from that. It's read-only and per site. This is Kitting's side of the kitting-restock contract.
- New exports: `restockNeeds`, `stockCount`, `setupProgress`, `siteShrinkage` and their types.

Tested: 67 integration tests against a real MongoDB on Payload 3.92 (6 new), plus a check of the setup, count, Today and shrinkage pages in a browser with made-up data. Not tested: a screen reader, and pressing "Use N%" with a real mouse (keyboard and scripted clicks worked; the automated browser's mouse clicks didn't reach it twice). That mouse check is step 8 of the owner's test T14.

## 0.1.0 (2026-11-09)

First release, published by hand. Supplies, suppliers, stock movements, lots, recipes, builds by scanning external IDs, assembled units, build requests, fulfilment (assign, swap, release, ship), box recommendations, ready-stock states and alerts with five ways to set the target, and an optional adapter for Payload's ecommerce plugin.
