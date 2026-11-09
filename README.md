# payload-plugin-kitting

Kitting for [Payload](https://payloadcms.com): anyone from a café to a genomics lab can track their supplies, and optionally build multi-part products (kits) from them. Used plainly, it's a supply tracker. Switch on more and it builds kits, keeps a ready stock and helps you pack orders.

It's meant for people with no IT department. You set it up once and carefully, with every item and a recipe for everything you make, down to the gram or the microlitre. From then on it knows how much of everything you need.

**Status: 0.1.0, not on npm yet. All three levels are built.** Anything not built yet says so.

## Two examples

The same few words cover both: an **item** is anything you keep in stock, a **recipe** says what goes into one of something, a **build** makes one or more from a recipe, and an **assembled unit** is one you've built and labelled with an **external ID**.

| | A café | A genomics lab |
|---|---|---|
| Items | Beans (bought in 1 kg bags, used in grams), milk, cups, lids, syrups | Swabs, tubes, buffer (bought in litres, used in microlitres), labels, mailers |
| Recipes | A latte: 18 g beans, 200 ml milk, a cup, a lid. House syrup is its own recipe, used in many drinks | A sample kit: two swabs, a tube with 500 µl buffer, a label, a mailer |
| Builds | Drinks, as they're sold | Kits, each scanned in under the ID printed on its tube |
| Lots and use-by | Milk goes off: oldest first, out-of-date stock written off | Each buffer and swab lot has an expiry; every kit records which lots went into it |
| Shrinkage allowance | Spills and spoilage: "18 g of beans + 5% shrinkage allowance" | Failed and defective kits: a failure rate, learned from what gets written off |
| Ready stock | (not usually) | Kits kept built and ready to send, with a recommended level |

## Levels

You switch on only what you need, and the simple case stays simple:

1. **Supply tracker.** Items in any unit, suppliers, lots and use-by dates, a stock log, the shrinkage allowance and low-stock email. Nothing else. *Built.*
2. **Recipes and builder.** Recipes, including recipes that use other recipes, and a builder in the admin where you scan or type each unit's external ID: its supplies come off stock and it records the lots that went into it. *Built.*
3. **Fulfilment.** Ready units assigned to orders, with a "build one" queue that later builds fill, and a scan-time swap and release for packing. How many to keep ready, by one of five methods, with OK, build more and urgent states and one email per change. Box suggestions by cost, with real postage from a shipping plugin when there is one. Native integration with Payload's ecommerce plugin. *Built.* The overview shows each recipe's ready stock and every method side by side, with a button to accept one.

Today levels 1 and 2 are always on together; the switches come with the builder.

## Built into every level

- **Shrinkage allowance.** Shrinkage is the usual business word for stock lost to damage, spoilage, defects or errors. Each item, recipe and recipe line can carry a shrinkage allowance in %, added to what a recipe uses and recorded on each movement ("18 g of beans per drink + 5% shrinkage allowance"). The most specific wins: line, then recipe, then item, then the site default. Each site switches it on or off and sets its default in **Kitting settings** in the admin (`kitting-settings`, one per site); the plugin's `shrinkage: { enabled, defaultPercent }` are only the starting values. 0 turns it off for one item. Each supply's page shows the shrinkage **learned** from the last 90 days, with the reasoning ("recipes used 12 of Buffer tube. The shrinkage allowance took 0.24, 1 was written off… about 10.3% lost"), and a "Use 10.3%" button for people who may change it; nothing changes until someone presses it. It's the allowance taken, plus what was written off, minus what counts found extra, as a share of what recipes used, and it needs 10 recipe uses first (`suggestShrinkagePercent`).
- **Units.** Each item is counted in one unit (g, ml, µl, each…). Enter stock in any unit of the same kind (kg for g, l for µl) or in one of the item's packs ("1 kg bag" = 1000 g), and it's converted once on the way in. Recipe lines can use other units too.
- **Lots and use-by dates** (per item, "Track lots"). Each delivery becomes a lot with its own number and use-by date, or one worked out from the item's shelf life. Stock is used first to expire first, and expired lots are never used. Every movement records its lot. Expired lots are written off as shrinkage (`writeOffExpired`, and automatically when the overview opens). The overview lists what to use soon.

- **Getting started** at `/admin/supplies/setup`: three steps in plain words (your supplies, what you make, a first stock count), with what's done so far. Until all three are done, the overview links to it.
- **Stock count** at `/admin/supplies/count`: type what's really on the shelf; empty boxes are skipped, and you see each difference before saving. Each difference becomes one adjustment ("Stock count") in one transaction. With lots, a shortfall comes off expired lots first, then the first to expire, and extra goes into the newest lot. Also `stockCount(payload, [{ item, counted }])` and `POST /api/kitting/count`, which refuses the whole count if any supply isn't the person's to manage.
- **Today** at the top of the overview: what to buy (supplies below level, by supplier), what to build (with urgent ones marked, and kits waiting for orders), and what to use soon.

Later, not yet: ordering from suppliers when something stays low for a few days (see [docs/roadmap.md](docs/roadmap.md)), and turning till sales into usage.

**Testing so far:** 66 tests pass (audited 2026-11-08, see [docs/test-audit.md](docs/test-audit.md)): 20 pure ones (units, lots, the shrinkage allowance, every stock method against known values, packing, and the commerce and shipping contracts with made-up doubles), and 45 against a real MongoDB (in memory, single-node replica set) on Payload 3.92: movements, units and packs, the shrinkage allowance and its suggestion, lots used first to expire first with expired ones written off, nested recipes, the builder (lots per unit, refusals, voiding, the HTTP endpoint's access), the ready-stock recommendation, assigning, queueing, swapping and releasing units for orders, every ready-stock state and its one email, box suggestions with and without a carrier, orders through Payload's real ecommerce plugin, accepting a number to keep, recipes, the refusal to go below zero, the low-stock email firing once, two senders racing for one alert, site isolation and access. The overview at `/admin/supplies` was checked in a local dev server of a real host app with made-up data: it renders, its headings and tables are in order, and its text and buttons measured 15:1 contrast or better in dark mode. On 2026-11-08 the overview (ready stock included), the builder and a built unit's page were opened in a local dev server of the same host app with made-up data. A batch was scanned and built from the keyboard alone, a repeated ID was refused, a used one gave a clear message, and the unit's page showed its lots, with no server errors. On 2026-11-09 the getting-started page, the stock count (keyboard only, with an invalid box refusing to save) and the Today summary were checked the same way. I haven’t tried a screen reader; that’s part of the owner’s hands-on test (T14 in the ops tests list).

## What it does

- **Supplies** (`supply-items`): name, unit (each, g, ml…), SKU, supplier, on hand, low-stock level, reorder quantity, notes. You give the opening stock when you add one.
- **Suppliers**: name, order email, phone, website, usual delivery time, notes.
- **Lots** (`supply-lots`): for items with lots tracked, one per delivery, with its number, use-by date and what's left. Made when stock is received.
- **Stock movements** (`supply-movements`): the stock log. Received, used, written off (spoiled, damaged, defective, expired, lost) or adjusted (+ or −), with who, why, a reference and the lot. A movement can't be edited or deleted, even through the Local API: you fix a mistake with an adjustment. On hand is only ever changed by a movement, so it always equals the sum of the item's log, opening stock included.
- **Recipes** (`supply-recipes`): what goes into one of something, as supplies × quantity in any unit that converts. A line can use another recipe: a house syrup that makes 1 litre, used 20 ml per drink, takes a fiftieth of the syrup's sugar and water each time. A recipe can't use itself, however deep. Your code calls `applyRecipe` when it makes something, and the plugin writes one `used` movement per supply and lot, in one transaction.
- **The builder** at `/admin/supplies/build`: choose a recipe, then scan or type each unit's ID (a barcode scanner that types and presses Enter works). Building takes the supplies off stock and makes one **built unit** (`assembled-units`) per ID, each recording which lots went into it. It refuses an ID scanned twice, one already built on that site, a batch bigger than the recipe's "most to build at once", and not having enough. Units can't be made, changed or deleted by hand, only their notes. `voidUnit` takes one out of use: a dud keeps stock as it is, and "built by mistake" with `returnToStock` puts its supplies back into the lots they came from. The same is at `POST /api/kitting/build` and `/api/kitting/void` for people who may manage that recipe or unit.
- **Going below zero** is refused by default. Nothing is written, and the error names every supply that's short and by how much. Set `negativeStock: 'warn'` to let it through and get the shortages back instead.
- **Low-stock email**: when a supply drops below its level, one email goes to the addresses you set. No more about that supply until it's back at or above the level. If your site has email off, the alert is recorded as not sent, and it isn't sent later.
- **Overview** at `/admin/supplies`: what's below level, grouped by supplier with their contact details and a suggested reorder (the reorder quantity, or enough to get back to the level if that's more), then every supply.
- **Sites**: with `scopeField` (for example `tenant` from Payload's multi-tenant plugin), every link stays inside one site. A recipe can't use another site's supplies, a movement takes its site from its supply, and recipe keys are unique per site.

It doesn't do purchase orders, costs or prices yet.

## Install

```bash
npm install @captiveorigins/payload-plugin-kitting
```

```ts
import { kittingPlugin } from '@captiveorigins/payload-plugin-kitting'

export default buildConfig({
  plugins: [
    kittingPlugin({
      access: {
        manage: ({ req }) => req.user?.role === 'admin',
        read: ({ req }) => Boolean(req.user),
      },
      alerts: { recipients: ['stock@example.com'] },
    }),
  ],
})
```

Then run `payload generate:importmap`, because the overview is an admin view.

If your app already has a collection with one of Kitting's slugs (for example `box-types`), Kitting stops at startup and says which; give it other slugs: `kittingPlugin({ slugs: { boxes: 'kitting-boxes' } })`. It never replaces your collection.

## Orders

```ts
import { assignUnits, release, shipUnits, swapUnit } from '@captiveorigins/payload-plugin-kitting'

// Keep 3 kits for an order: ready ones first (oldest built first), a build request for the rest.
// Running it again for the same reference adds only the difference.
await assignUnits(payload, { key: 'sample-kit' }, 3, { reference: 'Order 1042', scope: siteId, req })

// At packing, the scanned unit decides. It fills a place the order is waiting for, or takes the place
// of one it already holds, which goes back to ready.
await swapUnit(payload, { reference: 'Order 1042', take: { externalId: 'ZX-1001' }, scope: siteId, req })

await shipUnits(payload, [unitId], { req })
// Unpacking one, or a cancelled order (all its units back to ready, its requests cancelled).
await release(payload, { reference: 'Order 1042', unit: { externalId: 'ZX-1001' }, scope: siteId, req })
await release(payload, { reference: 'Order 1042', scope: siteId, req })
```

**Ready-stock states.** Set "Keep this many ready" on a recipe and Kitting watches it, by these rules:

| Ready units | Supplies | State |
|---|---|---|
| At or above the number | fine | OK |
| At or above the number | low | Enough ready, supplies low (for your information) |
| Below the number | enough to build them | Build more |
| Below the number | low | Urgent |

"Low" is either a supply in the recipe below its level, or not enough usable stock to build up to the number. You choose which on each recipe; the default is either. One email goes out on each change into a state that isn't OK, never twice, and nothing goes out when it's back to OK. Building, ordering, releasing, voiding, writing off and recording stock all update the state.

Build requests (`build-requests`) list what's waiting, oldest first. A build gives its new units to them first, in order; pass `fillRequests: false` to `buildUnits` to keep a batch ready instead. Requests can't be made by hand, only cancelled.

## With Payload's ecommerce plugin

Turn it on with `ecommerce: { enabled: true }`, and put Kitting after `ecommercePlugin` in `plugins`.

- **Products:** products and variants get a "Built from recipe" field. Their "Ready to send" follows the recipe's ready units, and so does `inventory` when your shop counts inventory.
- **New orders:** each kitted line gets ready units, oldest first, or a queued build. Saving the order again doesn't take more.
- **Cancelled or refunded orders:** their units go back to ready, and their waiting builds are cancelled.

It's off by default. If your own code assigns units for some orders, use `skipOrder: (order) => …` to leave those alone. The reference on units is `Order <id>` unless you pass `reference`. Tested against the real plugin (3.92.1, inventory on, no payments).

## Box suggestions

Add your boxes (`box-types`): their outside size, cost, empty weight, the most they can weigh, and how many of each recipe fit. Give the recipe a packed weight, and add your postage by weight (`postage-rates`). Then:

```ts
const { packings, notes } = await recommendBoxes(payload, { recipe: { key: 'sample-kit' }, count: 5, scope: siteId, to })
// packings[0].summary: "1 × Small mailer (4 each) + 1 × Envelope (1 each): boxes $1.20 + postage $11.00 = $12.20"
```

Already keep a list of boxes elsewhere in your app? Pass `boxes: { source: async ({ recipe, scope, req }) => [...] }`, returning `{ id, name, capacity, cost?, emptyWeight?, maxWeight?, dimensions? }` (grams; cm or in). Kitting then reads your list and adds no box collection of its own.

It tries every way to pack them into one box type, or one type plus one box for the rest, within each box's weight limit. Then it ranks them by box cost plus postage, then fewest boxes, then least empty space. With a shipping plugin (`shipping: { provider }`, or one that registers itself at `config.custom.shipping.provider`), it asks for real rates for the best few and uses them. If the carrier is down or has no rate for a box, it uses your postage rates and says so in `notes`. Without a packed weight it ranks by box cost alone and says so.

## How many to keep ready

Each recipe has "Ready stock" settings, and `recommendReadyStock(payload, recipeId)` gives every method's answer side by side, the chosen one first, each with its reasoning in plain words: "About 1.4 a day over the last 90 days, a 5-day build and a daily check, 95% service → keep 14 ready (8.4 expected, plus 5.6 safety stock)." It never changes anything by itself: you decide.

| Method | Works out | Suits |
|---|---|---|
| Safety stock (default) | Average demand × (days to build + days between checks), plus z × σ × √(the same days), with z from your service level (95% → 1.645) | Steady demand with day-to-day ups and downs |
| Days of cover | Average demand × N days | A rule you already use, such as two weeks of sales |
| Minimum and maximum | Build up to the maximum once ready stock falls to the minimum | Building in set batches, or very low or irregular sales |
| Following the trend | Holt's smoothing: today's level and trend, projected over the build time, plus safety stock | Growing, shrinking or seasonal demand |
| A fixed number | The number you set | New products, or when you know better than the history |

Demand is weighted towards recent weeks (a day 30 days old counts half). Until there are 28 days since the first sale, every method falls back to the fixed number and says so. The target is capped at the recipe's "most to build at once". Demand comes from units assigned to orders over the history window; you can pass your own sales instead: `recommendReadyStock(payload, id, { sales: [{ at, quantity }] })`. The overview shows the comparison for every recipe with built units or a number to keep, and "Use 14" sets the number after you click it (`POST /api/kitting/baseline`, for people who may manage that recipe).

## Building units from your code

```ts
import { buildUnits } from '@captiveorigins/payload-plugin-kitting'

const { units } = await buildUnits(payload, { key: 'sample-kit' }, ['ZX-1001', 'ZX-1002'], { scope: siteId, user: req.user })
// units[0].lotsUsed: [{ item, lot, quantity }, …]
```

To create or link your own record for each unit in the same transaction, pass `units: { onBuild: async ({ unit, recipe, req }) => { … } }` to the plugin. Throw to refuse the build; nothing is kept.

## Using stock when you make something

```ts
import { applyRecipe, KittingError } from '@captiveorigins/payload-plugin-kitting'

try {
  const { movements } = await applyRecipe(payload, { key: 'sample-kit' }, 50, {
    reference: 'Kit batch 2026-11-08',
    user: req.user,
  })
} catch (error) {
  if (error instanceof KittingError && error.code === 'notEnoughStock') {
    // error.shortages: [{ name, unit, onHand, needed, short }]
  }
  throw error
}
```

To make the stock part of a bigger change, pass your transaction as `req`. If you roll back, the stock goes back too. The alert can't go out before your commit, so call `sendPendingAlerts(payload)` after it. If you don't, the next save or a visit to the overview sends it.

```ts
const transactionID = await payload.db.beginTransaction()
await applyRecipe(payload, { key: 'house-latte' }, 1, { req: { transactionID }, scope: siteId })
// …your own writes with the same req…
await payload.db.commitTransaction(transactionID)
await sendPendingAlerts(payload)
```

With `scopeField`, a recipe key needs its site: `{ key, scope }`. `{ id }` works without one.

`applyRecipe` isn't named `useRecipe` on purpose: React's lint rules treat any `use…` call outside a component as a hook and fail the build.

## Options

| Option | Default | |
|---|---|---|
| `slugs` | `supply-items`, `suppliers`, `supply-movements`, `supply-recipes`, `supply-lots`, `assembled-units`, `build-requests`, `box-types`, `postage-rates`, `kitting-settings` | |
| `units.onBuild` | none | Runs for each built unit inside the build's transaction |
| `shipping.provider` | none | A shipping plugin's rates, for box suggestions |
| `shipping.currency` | `USD` | For showing costs |
| `boxes.source` | none | Your own box list for box suggestions, instead of Kitting's box collection |
| `ecommerce` | off | `{ enabled, products, variants, orders, reference, skipOrder }`, with Payload's ecommerce plugin |
| `access.manage` | signed-in admin users | Add and edit supplies, suppliers and recipes, and record movements. May return a query |
| `access.read` | same as `manage` | See them |
| `scopeField` | none | The field that separates sites, such as `tenant`. Your tenant plugin adds it |
| `negativeStock` | `'refuse'` | Or `'warn'`. `applyRecipe` can override it per call |
| `shrinkage.enabled` | `true` | The starting value; each site can switch it in Kitting settings |
| `shrinkage.defaultPercent` | `0` | For items without their own |
| `lots.warningDays` | `14` | How soon before its use-by date a lot shows under "Use soon". Items can set their own |
| `lots.autoWriteOff` | `true` | Write off expired lots when the overview opens |
| `alerts.recipients` | none | A list, or `({ payload, item }) => string[]` (`item.scope` is the site) |
| `alerts.canSend` | always | Return false where email is off, for example in development |
| `alerts.sendEmail` | `payload.sendEmail` | Your own delivery |
| `alerts.render` | a short plain message | Your own subject, HTML and text |
| `overrides` | none | Change each collection before it's added, for example to add a tenant field or hooks |
| `adminView` | `true` | The overview at `/admin/supplies` and its nav link |
| `adminGroup` | `Supplies` | Sidebar group |

Movements can't be edited or deleted whatever `access` says. A trusted cleanup script, such as one that removes a whole site, can delete them by passing `context: { kittingAllowDelete: true }`. The same flag lets it delete a supply that has history.

## Limits

- Alerts are only as exact as your database's transactions. On MongoDB they need a replica set, which Atlas always has. Without transactions, two saves at the same moment could both read the same stock.
- When an admin records a movement, the email goes out at the end of the save, just before it's committed. If that final commit fails, an email can arrive for a change that didn't stick.
- Quantities can be fractional and are rounded to six decimal places.
- A lot's use-by date is a day; the whole day is usable, and it's compared in UTC.
- With an allowance on, everyday losses are covered by it: write off only the unusual (a dropped bag, a failed batch), or it's counted twice until the next count corrects it.
- Kitting settings are one per site. Creating them for a site is checked against `access.manage`; keeping each site's records to its own site is your tenant plugin's job, as for supplies.

## Development

```bash
npm install
npm test            # Vitest with an in-memory MongoDB replica set
npm run typecheck
npm run build
npm run leak-check
```

## License

MIT. See [LICENSE](LICENSE).
