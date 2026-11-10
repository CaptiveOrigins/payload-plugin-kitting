# Roadmap

Planned, not built. Each item will move into the README when it exists.

## Moved: ordering from suppliers

Built as its own plugin, Restock (`@captiveorigins/payload-plugin-restock`, decided 2026-11-09), so Kitting stays usable without it. Restock drafts purchase orders from Kitting's `restockNeeds`, a person approves every order, and nothing is bought by the plugin. The design note that was here (2026-11-08) is in this file's git history; Restock's own decisions replace it.

## Later: point-of-sale integrations

Turn sales at the till into usage, through recipes, so a café doesn't record what each drink used. One adapter per till system, each optional, read-only on the till's side.
