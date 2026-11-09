# Roadmap

Planned, not built. Each item will move into the README when it exists.

## Later: ordering from suppliers

When a supply stays under its low-stock level for a set number of days (N, configurable), Kitting drafts an order to that supply's supplier.

Design note (2026-11-08):

- **Never spends without a yes.** By default, a drafted order waits for a person to approve it in the admin. An owner can choose to send orders without approval only for a supplier and a spending limit they set themselves, and every order sent that way is listed and can be reviewed afterwards.
- **Supplier catalogues.** Each supplier gets products with their pack size, price and minimum order. These link to supplies, using the unit conversions, so "2 × 1 kg bag" covers "about 2,000 g short".
- **Quantity.** The suggested reorder (the reorder quantity, or enough to get back to the level if that's more), rounded up to whole packs and the supplier's minimum.
- **Sending.** By email to the supplier's order address first. Supplier APIs come later, one adapter at a time, each optional.
- **No double orders.** A drafted or sent order for a supply stops new drafts for it until the order is received (recorded as a `received` movement) or cancelled.
- Approving an order follows the host's email switch, the same as low-stock alerts.

## Later: point-of-sale integrations

Turn sales at the till into usage, through recipes, so a café doesn't record what each drink used. One adapter per till system, each optional, read-only on the till's side.
