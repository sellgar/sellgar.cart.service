export type Unavailability =
  | 'not_sold'
  | 'hidden'
  | 'sync_pending'
  | 'price_missing'
  | 'currency_mismatch'
  | 'out_of_stock'
  | 'insufficient_stock'
  | 'checkout_in_progress';
