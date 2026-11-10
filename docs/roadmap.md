# Roadmap

Planned, not built. Each item will move into the README when it exists. Open work is tracked in the ops task log (owner, 2026-11-10, D26): the packing station is K10, the 0.3.0 release K11, point-of-sale K13.

## Moved: ordering from suppliers

Built as its own plugin, Restock (`@captiveorigins/payload-plugin-restock`, decided 2026-11-09), so Kitting stays usable without it. Restock drafts purchase orders from Kitting's `restockNeeds`, a person approves every order, and nothing is bought by the plugin. The design note that was here (2026-11-08) is in this file's git history; Restock's own decisions replace it.

## Later: point-of-sale integrations

Turn sales at the till into usage, through recipes, so a café doesn't record what each drink used. One adapter per till system, each optional, read-only on the till's side.

## 0.3.0: build straight into an order (agreed with Kits, 2026-11-10; built 2026-11-10, unreleased)

`buildUnits(payload, recipe, ids, { scope, req, assignTo: 'Order <id>' })`: units built at packing go to that reference first. They fill its open build request if it has one, otherwise they're assigned to it directly. The rest go to other requests as today. A reference that holds nothing and needs nothing is refused with `nothingReserved`. `onBuild` still runs first, in the same transaction. About half a day with tests. Kits uses it at its packing station (platform draft PR #88).
