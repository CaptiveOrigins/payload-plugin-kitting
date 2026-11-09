# payload-plugin-kitting

Kitting for [Payload](https://payloadcms.com): track supplies, and optionally build multi-part products (kits) from them. Used plainly, it's a supply tracker. Switch on more and it builds kits, keeps a ready stock and helps you pack orders.

It's meant for a small business with no IT department. Picture a family-run coffee shop. They set it up once, carefully: every bag of beans, every carton of milk, and a recipe for every drink, down to the gram. From then on it knows how much of everything they need. The aim is to make running the stock side of a business easy enough that the owners can do it themselves.

**Status: 0.1.0, not on npm yet. Only level 1 and part of level 2 exist so far.** Most of what's described below is planned, and each item says so.

## Levels

You switch on only what you need, and the simple case stays simple:

1. **Supply tracker.** Supplies, suppliers, a stock log and low-stock email. Nothing else. *Built.*
2. **Recipes and builder.** What goes into one drink, kit or product. Recipes and `applyRecipe` are built. *Planned:* a builder in the admin where you scan or type each kit's ID and its supplies are taken off automatically, and recipes that use other recipes (a batch of house syrup used in many drinks).
3. **Fulfilment.** *Planned:* ready stock assigned to orders (natively with Payload's ecommerce plugin, or through Kitting's own API), a "make one" queue, a recommended ready-stock level learned from your sales, and box suggestions by cost, using real postage when a shipping plugin is installed.

Today levels 1 and 2 are always on together; the switches come with the builder.

## Planned for every level

- **Waste allowance.** Spills, spoilage, defects and duds happen. Each supply and recipe can carry a loss allowance in %, shown plainly: "18 g of beans per drink + 5% waste allowance". It can be switched off for the whole site, and overridden per item. Optionally, Kitting suggests the % from the corrections you've recorded.
- **Units.** Buy in one unit and use in another: a 1 kg bag used 18 g at a time, or packs of 50 used one at a time. You set each conversion once.
- **Use-by dates** (optional): a shelf life per supply or batch, warnings before things expire, and the oldest used first. Expired stock is written off and counts as waste.
- **Getting started and everyday use.** A guided setup (your supplies, then your recipes, then a first stock count), and an everyday page: what's low, what to make, what to buy. The wording is meant for a shop owner, not an engineer.

Later, not yet: ordering from suppliers when something stays low for a few days (see [docs/roadmap.md](docs/roadmap.md)), and turning till sales into usage.

**Testing so far:** 16 tests pass against a real MongoDB (in memory, single-node replica set) on Payload 3.92: movements, recipes, the refusal to go below zero, the low-stock email firing once, two senders racing for one alert, site isolation and access. The overview at `/admin/supplies` was checked in a local dev server of a real host app with made-up data: it renders, its headings and tables are in order, and its text and buttons measured 15:1 contrast or better in dark mode. It hasn't been tried by a person, with a keyboard or a screen reader.

## What it does

- **Supplies** (`supply-items`): name, unit (each, ml, metres…), SKU, supplier, on hand, low-stock level, reorder quantity, notes. You give the opening stock when you add one.
- **Suppliers**: name, order email, phone, website, usual delivery time, notes.
- **Stock movements** (`supply-movements`): the stock log. Received, used, or adjusted (+ or −), with who, why and a reference. A movement can't be edited or deleted, even through the Local API: you fix a mistake with an adjustment. On hand is only ever changed by a movement, so it always equals the sum of the item's log, opening stock included.
- **Recipes** (`supply-recipes`): what goes into one of something, as supplies × quantity. Your code calls `applyRecipe` when it makes something, and the plugin writes one `used` movement per supply, in one transaction.
- **Going below zero** is refused by default. Nothing is written, and the error names every supply that's short and by how much. Set `negativeStock: 'warn'` to let it through and get the shortages back instead.
- **Low-stock email**: when a supply drops below its level, one email goes to the addresses you set. No more about that supply until it's back at or above the level. If your site has email off, the alert is recorded as not sent, and it isn't sent later.
- **Overview** at `/admin/supplies`: what's below level, grouped by supplier with their contact details and a suggested reorder (the reorder quantity, or enough to get back to the level if that's more), then every supply.
- **Sites**: with `scopeField` (for example `tenant` from Payload's multi-tenant plugin), every link stays inside one site. A recipe can't use another site's supplies, a movement takes its site from its supply, and recipe keys are unique per site.

It doesn't do purchase orders, costs or prices, or barcode scanning.

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

## Using stock when you make something

```ts
import { applyRecipe, KittingError } from '@captiveorigins/payload-plugin-kitting'

try {
  const { movements } = await applyRecipe(payload, { key: 'gift-box' }, 50, {
    reference: 'Batch 2026-11-08',
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
await applyRecipe(payload, { key: 'gift-box' }, 50, { req: { transactionID }, scope: siteId })
// …your own writes with the same req…
await payload.db.commitTransaction(transactionID)
await sendPendingAlerts(payload)
```

With `scopeField`, a recipe key needs its site: `{ key, scope }`. `{ id }` works without one.

`applyRecipe` isn't named `useRecipe` on purpose: React's lint rules treat any `use…` call outside a component as a hook and fail the build.

## Options

| Option | Default | |
|---|---|---|
| `slugs` | `supply-items`, `suppliers`, `supply-movements`, `supply-recipes` | |
| `access.manage` | signed-in admin users | Add and edit supplies, suppliers and recipes, and record movements. May return a query |
| `access.read` | same as `manage` | See them |
| `scopeField` | none | The field that separates sites, such as `tenant`. Your tenant plugin adds it |
| `negativeStock` | `'refuse'` | Or `'warn'`. `applyRecipe` can override it per call |
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
