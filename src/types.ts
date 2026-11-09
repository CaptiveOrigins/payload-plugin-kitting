import type { Access, CollectionConfig, Payload, PayloadRequest } from 'payload'

export type ID = string | number

/**
 * What a movement does to stock. `adjusted` takes a signed change (a recount, a correction).
 * `written-off` takes stock out as shrinkage (spoiled, damaged, defective, expired, lost) and feeds the
 * learned shrinkage allowance.
 */
export type MovementKind = 'received' | 'used' | 'adjusted' | 'written-off'

/** Why stock was written off. */
export type WriteOffReason = 'spoiled' | 'damaged' | 'defective' | 'expired' | 'lost' | 'other'

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
  /** `ready-stock` for a recipe's ready-stock email (then `onHand` is how many are ready). Default `supply`. */
  kind?: 'supply' | 'ready-stock'
}

export type KittingPluginOptions = {
  /**
   * Collection slugs. Defaults: `supply-items`, `suppliers`, `supply-movements`, `supply-recipes`, `supply-lots`,
   * `assembled-units`, `build-requests`, `box-types`, `postage-rates`.
   */
  slugs?: { items?: string; suppliers?: string; movements?: string; recipes?: string; lots?: string; units?: string; requests?: string; boxes?: string; postage?: string }
  /**
   * Built units (level 2): things you build from a recipe and label with an external ID, such as a
   * kit with the ID printed on its tube. `onBuild` runs for each unit inside the build's transaction,
   * so your own record (for example a kit in your app) is created or linked in the same commit; throw
   * to refuse the build.
   */
  units?: { onBuild?: (args: { payload: Payload; req: Partial<PayloadRequest>; unit: BuiltUnit; recipe: { id: ID; name: string; key: string } }) => void | Promise<void> }
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
   * The shrinkage allowance: a % added to what a recipe uses, for stock lost to damage, spoilage, defects or errors, so
   * stock stays close to real without counting every day. `enabled: false` turns every allowance off.
   * `defaultPercent` applies to items without their own. An item, a recipe and a recipe line can each
   * set their own; the most specific wins (line, then recipe, then item, then this default).
   */
  shrinkage?: { enabled?: boolean; defaultPercent?: number }
  /**
   * Lots and use-by dates, for items with "Track lots" ticked. `warningDays` is the default for how
   * soon before a lot's use-by date it shows as expiring. With `autoWriteOff` (default true), expired
   * lots are written off as shrinkage when the overview is opened, and `writeOffExpired` does the same
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
    units?: (c: CollectionConfig) => CollectionConfig
    requests?: (c: CollectionConfig) => CollectionConfig
    boxes?: (c: CollectionConfig) => CollectionConfig
    postage?: (c: CollectionConfig) => CollectionConfig
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
  units: string
  requests: string
  boxes: string
  postage: string
  onBuild?: NonNullable<KittingPluginOptions['units']>['onBuild']
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
  shrinkage: { enabled: boolean; defaultPercent: number }
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
  /** One per item and lot used. `shrinkageAllowance` is the part of `change` that is the shrinkage allowance. */
  movements: { id: ID; item: ID; lot: ID | null; change: number; shrinkageAllowance: number; onHandAfter: number }[]
  /** Items that went below zero (only with `negativeStock: 'warn'`). */
  shortages: Shortage[]
}

export type UnitStatus = 'ready' | 'assigned' | 'shipped' | 'void'

/** What went into one built unit: per item, which lot and how much (in the item's unit). */
export type LotUse = { item: ID; lot: ID | null; quantity: number }

export type BuiltUnit = { id: ID; externalId: string; status: UnitStatus; lotsUsed: LotUse[]; scope?: ID | null }

export type BuildContext = {
  /** Join the caller's transaction. Call `sendPendingAlerts(payload)` after your commit. */
  req?: Partial<PayloadRequest>
  /** The scope (tenant id) to find a recipe key in. */
  scope?: ID
  user?: { id: ID } | null
  /** Shown on each movement. Default "Build of <n> × <recipe>". */
  reference?: string
  negativeStock?: NegativeStock
  /** Give the new units to waiting build requests, oldest first (default true). */
  fillRequests?: boolean
}

export type BuildResult = {
  recipe: { id: ID; name: string }
  units: BuiltUnit[]
  movements: ApplyRecipeResult['movements']
  shortages: Shortage[]
  /** New units that went straight to a waiting build request. */
  filled: { externalId: string; request: ID; reference: string }[]
}

export type AssignContext = {
  /** Join the caller's transaction (for example the one that records the order). */
  req?: Partial<PayloadRequest>
  /** The scope (tenant id) to find a recipe key in. */
  scope?: ID
  user?: { id: ID } | null
  /** The order, shown on assigned units and queued builds, for example "Order 1042". */
  reference: string
  /** Queue a build for what isn't ready (default true). */
  queue?: boolean
}

export type AssignResult = {
  recipe: { id: ID; name: string }
  /** Ready units given to this order, oldest built first. */
  assigned: BuiltUnit[]
  /** How many more are needed, queued as a build request (or not, with `queue: false`). */
  short: number
  request: { id: ID; count: number } | null
}
