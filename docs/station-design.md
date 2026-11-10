# Packing station: design (draft, 2026-11-10)

A packing screen in Kitting, one per order reference. You scan items in (building them on the spot if needed), see progress box by box, tick off packing steps, and ship. Whatever owns the orders, Kits on Captive Origins or any other site or plugin, plugs in as a **provider**, with no imports either way. Agreed in principle with Kits (code-91) on 2026-11-10, for after tour v3. Not built; nothing here is tested.

## What Kitting owns

- The **station view** in the admin, at `/admin/supplies/station/<reference>`, and a reference picker.
- **Scanning.** Keyboard input is the default: barcode scanners type, and so can a person. A scan plugin (for example a phone camera) can plug in through an optional adapter, never as a dependency.
- **Build at packing.** An item that isn't built yet is built and given to this order in one step (`buildUnits` with `assignTo`, Kitting 0.3.0).
- **Unit moves.** `swapUnit` at scan, `release` on unscan, `shipUnits` at ship.
- **Packing steps** from each box type's packaging recipe, ticked off on screen.
- **Packaging off stock at ship.** `applyRecipe` per box, with `negativeStock: 'warn'`.
- **Alerts** after the commit.

## What the provider gives

Registered at `config.custom.kitting.station`, by a site or a plugin. Kitting never assumes a path.

```ts
type StationProvider = {
  name: string
  /** On top of Kitting's own staff check. A missing reference and a refused one answer the same. */
  canOpen: (args: { user: unknown; reference: string; req }) => Promise<boolean>
  /** Which items go in which box, and each box's type. */
  boxPlan: (args: { reference: string; req }) => Promise<{ boxes: { number: number; boxType: { id: ID; name: string; packagingRecipeKey?: string }; items: number }[] }>
  /** Each scan, before Kitting moves anything. The message is in plain words and already translated; Kitting shows it as it is. */
  validateItem: (args: { code: string; reference: string; req }) => Promise<{ ok: true; box?: number } | { ok: false; code: 'recalled' | 'used' | 'surplus' | 'wrongOrder' | string; message: string }>
  /** When every planned item is in. For example, Kits issues activation secrets here. */
  afterAllScanned?: (args: { reference: string; req }) => Promise<void>
  /** Labels sets to offer on the screen. Only shown when the Labels plugin is present. */
  printSets?: (args: { reference: string; req }) => Promise<{ key: string; name: string }[]>
  /** At ship, inside the same transaction as Kitting's unit and packaging moves. For example, Kits' markShipped. */
  onShipped: (args: { reference: string; tracking?: string[]; req }) => Promise<void>
}
```

Rules:

- **Every call gets `{ req }` and runs inside Kitting's transaction.** A scan is one transaction: `validateItem`, the build if needed, and the unit swap. Shipping is another: `shipUnits`, `applyRecipe` per box, then `onShipped`. If any part throws, all of it rolls back. Alerts and emails go out after the commit.
- **Access fails closed.** The view and every action check Kitting's own `manage` access, then `canOpen`. If either is false or throws, the answer is the same "not found or not allowed" refusal.
- **Refusals are shown as given.** `validateItem`'s `code` is stable, so tests can check it, and its `message` is shown as written. A refusal moves nothing.

## The screen

- The order reference at the top, with a progress line such as "7 of 10 items".
- One card per box: its type, its items as they're scanned, and its packing steps (from the packaging recipe) as a checklist.
- A scan field that always has focus after each action. Each result is announced to screen readers through a polite live region ("Kit 1234… in box 2"). A refusal is shown in red text with its message, and in words as well as color.
- Every action has a keyboard path. Unscan is a button on each item, and Ship is enabled only when every item is in and every step is ticked.
- With the scan plugin present, a "Use camera" button opens it, and its result goes into the same field.

## Rough time

These are guesses of session days, not promises.

| Piece | Days |
| --- | --- |
| Provider contract, server actions in transactions, access | 1.5 |
| Station view: picker, box cards, steps, live region, keyboard | 2–3 |
| Tests (each refusal code, rollback on a failing provider call, access) and a browser check with made-up data | 1–1.5 |
| Total | about 5–6 |

This depends on Kitting 0.3.0 (`assignTo`, half a day), which comes first.

## Open points

- **The camera adapter's shape** comes from the scan plugin when it exists. The station needs only `onResult(code)`.
- **Kits may become a plugin** (`payload-plugin-sample-kits`, the owner is deciding). That changes nothing here, because the provider registers the same way.
