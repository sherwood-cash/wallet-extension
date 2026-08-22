/** Types shared across the popup. Kept free of imports so every module can take it. */

/** Which screen the shell is showing. Onboarding/unlock live outside this union —
 *  they replace the whole shell rather than sit inside it. */
export type Screen = 'home' | 'deposit' | 'swap' | 'withdraw' | 'receive' | 'send' | 'settings'

/** The three flows the segmented rail switches between. */
export type Flow = Extract<Screen, 'deposit' | 'swap' | 'withdraw'>

/** One line in the popup's local activity feed. Mirrors the web app's `Activity`
 *  shape so the two can be read side by side. */
export interface ActivityItem {
  kind: 'deposit' | 'withdraw' | 'swap' | 'send'
  label: string
  /** Pre-formatted signed delta, e.g. "+ 1.25 ETH". */
  delta: string
  positive: boolean
  hash?: string
  /** ms epoch — set by `pushActivity` when absent. */
  at?: number
}
