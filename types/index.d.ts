export type Card = { id: number; prompt: string; answer: string }
export type Deck = { name: string; status: 'idle' | 'offline' | 'empty' | 'ready'; queue: number[] }

declare module 'claude-code' {
  interface PluginState {
    medan: { card: Card | null; isRevealed: boolean; deck: Deck; reviewed: number }
  }
}
