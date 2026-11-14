# Decisions

## 2026-11-08 (owner)

- A new general plugin, first named `payload-plugin-supplies`, now `payload-plugin-kitting` (see below). Repo created private. MIT. Going public needs the owner's OK.
- Placeholders for now: made-up supplies, quantities, thresholds and alert addresses (example.com), clearly marked. The owner fills in the real ones later.
- Nothing in the plugin names a particular product, site or person.

## 2026-11-08 (made while building; the owner can change them)

- The host call is `applyRecipe`, not `useRecipe` as first sketched: React's `rules-of-hooks` lint fails any `use…` call outside a component, which would break the host's build.
- On hand is stored on the supply and changed only by movements. Opening stock is the first movement, so on hand always equals the sum of the log.
- "Below level" means on hand is under the level. At the level is fine. The alert clears once stock is back at or above it.
- An alert that couldn't go out because email was off stays "not sent". It isn't sent later, since by then it may be stale. The overview still lists the supply.
- A supply with history can't be deleted. "No longer used" keeps it and stops alerts.
- The suggested reorder is the reorder quantity, or enough to get back to the level if that's more.

## 2026-11-08 (owner, redesign; replaces "use on lot creation")

In the owner's words: "we should never have to mark supplies down as we use them — rather, we have a kit builder inside the UI."

- **Building.** Staff build assembled units in the admin. Scanning or typing a unit's external ID (for example a lab's kit ID) links that ID to the recipe it was built from, and building deducts the recipe's supplies automatically. Nobody counts by hand. Recipes cover different unit types and packaging. Corrections are adjustments.
- **Stock rules.** Each unit type has a baseline (how many ready units to keep on hand) and a maximum per build batch. Severity:
  - Ready units at or above baseline, supplies low: low concern, informational.
  - Ready units below baseline and supplies low: urgent.
  - Ready units below baseline, supplies enough: "build more".
- **Alerts** go by email to the configured addresses, once per change of state, never repeated.
- **Fulfilling.** An order is assigned existing ready units automatically. If there aren't enough, "build one" goes in a queue. The plugin recommends box sizes and units per box by cost and efficiency: box cost, weight, fit, and postage when rates exist.
- **Everything is a rule** (baseline, batch size, severity thresholds, box rules), editable in the admin and documented.
- **General names:** "assembled unit" and "external ID", never kit- or lab-specific. The host configures the rest.
- The host calls the builder and the fulfilment API instead of keeping its own stock logic (crossing `supplies-kits`).
- Placeholders still apply until the owner sends the real supplies.

## 2026-11-08 (owner): renamed to Kitting

- The repo and the package are now named `payload-plugin-kitting`. It was renamed before it was ever published, and GitHub redirects the old URL.
- Positioning, in the owner's words: Kitting "spells out that it can be dumbed down into just a supply tracker, but it's so much more (optionally, of course)". The description opens "Kitting for Payload: track supplies, and optionally build multi-part products (kits) from them…".
- **Three levels, each switched on in config and understandable on its own:**
  1. A plain supply tracker: items, stock and low-stock alerts, with nothing else on.
  2. Recipes and the kit builder.
  3. Order fulfilment, ready-stock baselines and box recommendations.

  The README shows all three.
- Names in code follow the package: `kittingPlugin`, `KittingPluginOptions`, `KittingError`, and the context flags `kittingInternal` and `kittingAllowDelete`. Collection slugs keep `supply-…`, because that's what they hold.

## 2026-11-08 (owner): recommended ready stock, learned over time

In the owner's words: "over time, it should recommend how many kits to keep in stock based on average sales volume… if it's more complicated then use that". It uses the standard inventory method, not a flat multiplier.

- Target = expected demand over (build lead time + review period) + safety stock.
- Safety stock = z × σ(daily demand) × √(lead time + review period). z comes from a configurable service level: the default is 95%, z ≈ 1.65.
- Demand comes from a moving window of recent sales, configurable (for example 90 days) and weighted towards recent weeks.
- With too little history, it falls back to the manual baseline and says so.
- The target is capped at the maximum batch. The recommendation and its reasoning show next to the manual baseline, for example "about 1.4 a day, a 5-day build, 95% service → keep 14 ready".
- An admin accepts it. It never changes the baseline silently.
- Everything is configurable and documented. Unit tests check the maths against known values.

## 2026-11-08 (owner): native commerce and shipping

- **Commerce.** Kitting integrates natively with Payload's official `@payloadcms/plugin-ecommerce`. A product, or a variant, can be backed by a kit recipe. Its ready-kit stock shows as the product's availability. An order placed through ecommerce triggers fulfilment: a ready kit is assigned, or a build is queued. Without ecommerce, the same works through Kitting's own API, so Kitting stays usable on its own.
- **Shipping.** A sibling plugin, `payload-plugin-shipping`, is coming: carrier adapters (EasyPost first), rates, labels, tracking and returns.
  - Kitting's box recommendations hand off to it. Each packed box's dimensions and weight go in, and rates come back to refine the "best by cost" choice.
  - The interface is a small typed contract in `src/contracts/shipping.ts` (crossing `kitting-shipping`), and either plugin works without the other.
  - With a shipping provider, Kitting uses real rates. Without one, or if the provider fails, it uses its own cost rules and says so.
  - Kitting only asks for rates. Labels, tracking and returns belong to the shipping plugin.

## 2026-11-08 (owner): recommended stock, several methods with one default

This extends the "learned over time" decision above. Businesses approach this differently, so the method is chosen per recipe or product:

- **Statistical safety stock** (default): demand over lead time plus review period, plus z·σ·√(LT+R), with a configurable service level.
- **Simple multiplier:** average daily sales × N days of cover.
- **Min/max:** build when ready stock falls to a minimum, up to a maximum.
- **Trend-aware:** an exponentially weighted average, for growing or seasonal demand.
- **Manual:** a fixed number. This is also the fallback when there's too little history.

Each method shows its result with a plain-language explanation. The admin can compare the methods side by side before choosing one. The README says when each one suits a business. Unit tests check each method against known values.

## 2026-11-08 (owner): who Kitting is for

The owner's example: a family-run coffee shop sets it up once, "by being thorough and setting recipes down to the tee", and from then on it tracks how much they need of every single thing in the shop. "The point is that it could make running a business for someone so easy they could do it themselves." Sample kits on the first site stay the first use, but Kitting is designed and worded for a small business owner with no IT department. The layered setup stays (tracker → recipes and builder → fulfilment), so the simple case stays simple.

Planned as a result:

1. **Waste and dud allowance**, which the owner calls realistic "in all sectors of life".
   - A loss % per item and per recipe, covering spills, spoilage, defects and duds.
   - A global on/off, with per-item overrides.
   - Optionally, a suggested % learned from recorded adjustments over time.
   - Shown plainly, for example "needs 18 g of beans per drink + 5% waste allowance".
2. **Units and conversions:** g, kg, ml, l, units and packs of N. A supply can be bought in one unit and used in another (a 1 kg bag used 18 g at a time), with each conversion defined once.
3. **Nested recipes:** a recipe can use another recipe, such as a house syrup batch used in many drinks. Building or selling the parent draws down the sub-recipe correctly.
4. **Perishables (optional):** shelf life per item or batch, expiry warnings, and first-expiring-first-used. Expired stock is written off into the waste figures.
5. **Getting started:** a guided setup (items, then recipes, then a first stock count), and an everyday view of what's low, what to make and what to buy, in wording a café owner understands.
6. **Later, not now:**
   - Automatic supplier ordering after N days under the threshold. It's in docs/roadmap.md with a design note: supplier catalogues, approval by default, and never spending without a yes.
   - Point-of-sale integrations that turn sales into usage.

## 2026-11-08 (owner): from a café to a genomics lab

The owner: "Our point should be that anyone could use it from a cafe to a genomics lab." This is the README's opening line and the spirit of the package description.

- The docs use two worked examples side by side throughout.
  - **A café:** beans, milk, cups, syrups, perishables and a waste allowance.
  - **A genomics lab:** swabs, tubes, buffers, reagent lots, and sample kits with an external ID, lot and expiry tracking, and failure rates as the dud allowance.
- Every term stays neutral ("item", "recipe", "build", "assembled unit", "external ID"), so neither domain feels bolted on.
- Lot and batch tracking with expiry is planned. **Each built unit records which lots it used**, so a bad lot can be traced to every unit it went into.

## 2026-11-08 (made while building layers 1 to 3; the owner can change them)

- **Waste allowance.** It is taken off stock with each use, so stock stays close to real without daily counting. Recorded waste (`wasted` movements) is for the unusual. The learned % is (allowance taken + recorded waste − what counts found extra) ÷ what recipes used, over 90 days, once there are 10 recipe uses.
- **Waste settings.** The most specific setting wins: line, then recipe, then item, then the site default. The global switch and the default are set in config for now; an admin setting is planned.
- **Use-by dates.** A use-by date is a whole usable day, compared in UTC. Expired lots are never used, and are written off as `wasted` (expired).
- **Recording stock out by hand** on an item with lots takes the first-to-expire lot that covers the quantity. If no single lot does, it asks for one movement per lot.
- **Nested recipes** expand into their supplies at use time (no stock of the in-between, such as syrup). Making a batch into its own stock is a possible later addition. Nesting goes 8 deep at most, and a recipe can never use itself.
- **Built units.** External IDs are unique per site. Units are made only by the builder and can't be deleted. Only their notes can be edited by hand.
- **Voiding a unit.** A dud keeps stock as it is: its supplies were used. "Built by mistake" with return-to-stock puts the supplies back into the same lots.
- **Ready stock** is capped at the recipe's "most to build at once", as the owner asked. Demand counts from the first sale, weighted with a 30-day half-life, and needs 28 days of history before a method is trusted.

## 2026-11-08 (owner): "shrinkage"

The waste and dud buffer is called **shrinkage**, the standard business term for stock lost to damage, spoilage, defects or errors. It's "shrinkage allowance" (for example "Shrinkage allowance: 5%") in config, the admin, the docs and the code. This replaces "waste allowance" in the earlier entries above.

- Config: `shrinkage: { enabled, defaultPercent }`. Fields: `shrinkagePercent` on items, recipes and recipe lines. Each movement records its `shrinkageAllowance`. The suggestion function is `suggestShrinkagePercent`.
- Recorded losses are the movement kind `written-off`, replacing `wasted`. Each carries a `writeOffReason`: spoiled, damaged, defective, expired, lost or other. Write-offs feed the learned suggestion.
- Voided built units keep their own reasons (dud, damaged, built by mistake, other). These are about a unit, not about stock.

## 2026-11-08 (owner): test locally first, then publish

The first npm version comes only after the owner has tried Kitting by hand, and the publish waits for that test to pass. The test runs on the owner's Mac against a locally packed copy (`npm pack`) and the platform's local Kitting branch, with nothing published, pushed or merged. The platform branch `supplies-plugin` waits for the publish. This keeps the rule that the first published version has no untried UI.

## 2026-11-09 (made while building; the owner can change them)

- **Kitting settings.** These are a collection with one document per site, not a Payload global, because globals can't be per site. A site's settings override the plugin's config. The config values are only the starting point.
- **Learned shrinkage.** It's shown on each supply's page, and only a person's click applies it, which keeps "the person decides".

## 2026-11-10: standing rules from the owner

- Build it right: agnostic plugins with optional adapters, best architecture first. This repo imports no other plugin from this set.
- This repo is public, with limits on CI minutes.
- No plugin-family tags yet. None are in `package.json` keywords.
- The activation QR goes on the kit bag only, never on the kit's box. Kitting's own label presets (built unit, supply lot, shelf) carry no activation, and the packing station prints whatever the provider's sets list; activation stays the provider's (Kits').

## 2026-11-10 (made while building; the owner can change them): Shipping's rates through an adapter

- **An exported adapter, not a new option.** `ratesFromShipping({ quote, from })` turns Shipping's `quote(payload, input, req)` into a `ShippingProvider`, passed as `shipping: { provider }`. `quoteRates` stays the one contract, so other carriers and Kits' provider are unchanged, and the adapter has a home for what only Shipping needs (a full ship-from address, US only, inches and ounces). Kitting copies the shape of Shipping's function and imports nothing from it. It wraps Shipping's `quote`, not its carrier provider, so Shipping's go-ahead hook runs before every quote.
- **Failures fall back, visibly.** A provider that throws or gives the wrong shape never blocks packing. The suggestion carries `fallback` and a marked summary, and the error's name (not its message, which may hold carrier details) is logged once per provider.
- **Wrong shape at startup.** A provider passed in Kitting's own options without `quoteRates` stops startup. One found at `config.custom.shipping.provider` only warns, because the Shipping plugin keeps its own carrier provider there for its own use, and refusing would stop every site that installs both.
- 2026-11-13: moved to the ExtantApe GitHub organization and the `@extantape` npm scope at the same version. EXTANT APE owns its reusable tools and licenses them to the platform. The earlier package name is deprecated with a pointer here, and GitHub redirects the old repository address.
