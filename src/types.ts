import type { Access, CollectionConfig, Payload, PayloadRequest } from 'payload'

export type ID = string | number

/**
 * What a movement does to stock. `adjusted` takes a signed change (a recount, a correction).
 * `wasted` takes stock out and counts towards the waste figures (spilled, spoiled, expired, a dud).
 */
export type MovementKind = 'received' | 'used' | 'adjusted' | 'wasted'

/** Why stock was wasted. */
export type WasteReason = 'spilled' | 'spoiled' | 'expired' | 'defective' | 'dud' | 'other'

/** Where a low-stock alert stands. Empty while the item is at or above its level. */
export type AlertStatus = 'pending' | 'sending' | 'sent' | 'not-sent' | 'failed'

/** What happens when using stock would take an item below zero. */
export type NegativeStock = 'refuse' | 'warn'

/** One email. Default: `payload.sendEmail`. */
export type SendEmail = (args: { payload: Payload; to: string[]; subject: string; html: string; text: string }) => Promise<void>

/** The item an alert is about, as the email and recipient functions see it. */
export type AlertItem = {
  id: ID
  name: string
  unit: string
  sku?: string | null
  onHand: number
  lowStockLevel: number
  suggestedReorder: number
  supplier?: { id: ID; name: string } | null
  /** The item's scope (for example its tenant id) when `scopeField` is set. */
  scope?: ID | null
}

export type KittingPluginOptions = {
  /** Collection slugs. Defaults: `supply-items`, `suppliers`, `supply-movements`, `supply-recipes`, `supply-lots`. */
  slugs?: { items?: string; suppliers?: string; movements?: string; recipes?: string; lots?: string }
  /**
   * Who may do what. Plain Payload access functions, so they can return a query (for example
   * "only my sites"). `manage` adds and edits items, suppliers and recipes and records movements;
   * `read` sees them. Defaults: any signed-in user of the admin's user collection, for both.
   * Movements can never be edited or deleted, whatever these say.
   */
  access?: { read?: Access; manage?: Access }
  /**
   * A field that separates owners, such as `tenant` with Payload's multi-tenant plugin. The plugin
   * doesn't add it (your tenant plugin does); it keeps every link inside one owner: an item's
   * supplier, a recipe's items, a movement's item and recipe.
   */
  scopeField?: string
  /** Using stock below zero: `refuse` (default) writes nothing and says what's short; `warn` goes ahead and reports it. */
  negativeStock?: NegativeStock
  /**
   * The waste allowance: a % added to what a recipe uses, for spills, spoilage, defects and duds, so
   * stock stays close to real without counting every day. `enabled: false` turns every allowance off.
   * `defaultPercent` applies to items without their own. An item, a recipe and a recipe line can each
   * set their own; the most specific wins (line, then recipe, then item, then this default).
   */
  waste?: { enabled?: boolean; defaultPercent?: number }
  /**
   * Lots and use-by dates, for items with "Track lots" ticked. `warningDays` is the default for how
   * soon before a lot's use-by date it shows as expiring. With `autoWriteOff` (default true), expired
   * lots are written off as waste when the overview is opened, and `writeOffExpired` does the same
   * from a scheduled job.
   */
  lots?: { warningDays?: number; autoWriteOff?: boolean }
  alerts?: {
    /** Who gets low-stock emails. A list, or a function per item (for example per site). Empty: alerts are recorded, not sent. */
    recipients?: string[] | ((args: { payload: Payload; item: AlertItem }) => string[] | Promise<string[]>)
    /** May email go out from here right now (for example off in development)? Default: always. */
    canSend?: (args: { payload: Payload }) => boolean | Promise<boolean>
    /** Delivery. Default `payload.sendEmail`. */
    sendEmail?: SendEmail
    /** Your own wording or layout. Default: a short plain message with a link to the item. */
    render?: (args: { item: AlertItem; adminURL: string | null }) => { subject: string; html: string; text: string }
  }
  /** Change the generated collections (add fields, admin groups, hooks) before they are added. */
  overrides?: {
    items?: (c: CollectionConfig) => CollectionConfig
    suppliers?: (c: CollectionConfig) => CollectionConfig
    movements?: (c: CollectionConfig) => CollectionConfig
    recipes?: (c: CollectionConfig) => CollectionConfig
    lots?: (c: CollectionConfig) => CollectionConfig
  }
  /** Add the Supplies overview at /admin/supplies (below level, reorder list, all stock). Default true. */
  adminView?: boolean
  /** Admin sidebar group for the collections. Default `Supplies`. */
  adminGroup?: string
}

export type ResolvedSupplies = {
  items: string
  suppliers: string
  movements: string
  recipes: string
  lots: string
  userSlug: string
  read: Access
  manage: Access
  scopeField?: string
  negativeStock: NegativeStock
  recipients: NonNullable<NonNullable<KittingPluginOptions['alerts']>['recipients']>
  canSend: NonNullable<NonNullable<KittingPluginOptions['alerts']>['canSend']>
  sendEmail?: SendEmail
  render?: NonNullable<KittingPluginOptions['alerts']>['render']
  adminView: boolean
  adminGroup: string
  waste: { enabled: boolean; defaultPercent: number }
  lotWarningDays: number
  autoWriteOff: boolean
}

/** How a host refers to a recipe: by id, or by its key (within a scope when there is one). */
export type RecipeRef = { id: ID } | { key: string }

export type ApplyRecipeContext = {
  /**
   * Join the caller's transaction (for example the one that creates a kit lot): if the caller rolls
   * back, so does the stock. Without it, the plugin runs its own transaction. When joining, call
   * `sendPendingAlerts(payload)` after your commit, or the alert goes out on the next save.
   */
  req?: Partial<PayloadRequest>
  /** The scope (tenant id) to find a recipe key in. Required for `{ key }` when `scopeField` is set. */
  scope?: ID
  /** The person doing it, recorded on each movement. Default `req.user`. */
  user?: { id: ID } | null
  /** Shown on each movement, for example "Kit lot 275864". */
  reference?: string
  /** Why, in words. Default "Used by recipe <name> × <count>". */
  reason?: string
  /** Override the plugin's setting for this one call. */
  negativeStock?: NegativeStock
}

export type Shortage = { item: ID; name: string; unit: string; onHand: number; needed: number; short: number }

export type ApplyRecipeResult = {
  recipe: { id: ID; name: string }
  count: number
  /** One per item and lot used. `allowance` is the part of `change` that is the waste allowance. */
  movements: { id: ID; item: ID; lot: ID | null; change: number; allowance: number; onHandAfter: number }[]
  /** Items that went below zero (only with `negativeStock: 'warn'`). */
  shortages: Shortage[]
}
