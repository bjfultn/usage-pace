/** One rate-limit window as the meter keeps it. */
export type Limit = {
  /** Normalized window name: five_hour, seven_day, seven_day_fable, spend_limit... */
  kind: string
  /** 0..100 (past 100 on an exceeded spend limit). */
  percentUsed: number
  /** When the window resets, ms since epoch; absent when unknown. */
  resetsAt?: number
  /** When this reading was taken, ms since epoch. */
  at: number
  /** Where the reading came from. */
  source: 'engine' | 'headers' | 'plan'
}

declare module 'claude-code' {
  interface PluginState {
    'usage-pace': { limits: Shaped<Limit[]> }
  }
}
