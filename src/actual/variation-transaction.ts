export const VARIATION_NOTES = "Variation"
export const VARIATION_IMPORTED_ID_PREFIX = "fintual-variation:"

export interface ExistingVariationTransaction {
  id: string
  date: string
  notes?: string
  payee?: string | null
  imported_id?: string
}

export interface VariationTransactionInput {
  date: string
  amount: number
  payee?: string
  notes: string
  imported_id: string
  cleared: boolean
}
