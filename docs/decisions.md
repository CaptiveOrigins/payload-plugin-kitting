# Decisions

## 2026-11-08 (owner)

- A new general plugin, first named `payload-plugin-supplies`, now `payload-plugin-kitting` (see below). Repo under CaptiveOrigins, created private. MIT. Going public needs the owner's OK.
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

- The repo is now CaptiveOrigins/payload-plugin-kitting, and the package is `@captiveorigins/payload-plugin-kitting`. It was renamed before it was ever published, and GitHub redirects the old URL.
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
