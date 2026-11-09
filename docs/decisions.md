# Decisions

## 2026-11-08 (owner)

- A new general plugin, `payload-plugin-supplies`, package `@captiveorigins/payload-plugin-supplies`, repo CaptiveOrigins/payload-plugin-supplies. Created private. MIT. Going public needs the owner's OK.
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
