export { kittingPlugin } from './plugin.js'
export { ALLOW_DELETE, applyRecipe, defaultAlertEmail, isBelowLevel, sendPendingAlerts, stockReport, suggestedReorder, KittingError, type StockRow } from './stock.js'
export type {
  AlertItem,
  AlertStatus,
  ApplyRecipeContext,
  ApplyRecipeResult,
  MovementKind,
  NegativeStock,
  RecipeRef,
  SendEmail,
  Shortage,
  KittingPluginOptions,
} from './types.js'
export type {
  LengthUnit,
  PackedBox,
  RateRequest,
  RateResult,
  ShippingAddress,
  ShippingProvider,
  ShippingRate,
  WeightUnit,
} from './contracts/shipping.js'
