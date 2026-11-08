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
