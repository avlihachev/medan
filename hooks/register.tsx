import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Deck } from '../types'

const EASE = { again: 1, good: 3, easy: 4 } as const
const AREDUE_WINDOW = 20
const GRADE_DELAY_MS = 400
const SEP = '\u0001'

const card = atom({ plugin: 'medan', key: 'card' } as const, null)
const isRevealed = atom({ plugin: 'medan', key: 'isRevealed' } as const, false)
const deck = atom({ plugin: 'medan', key: 'deck' } as const, { name: '', status: 'idle', queue: [] })
const reviewed = atom({ plugin: 'medan', key: 'reviewed' } as const, 0)

type Settings = { deck: string; ankiConnectUrl: string }
type CardInfo = { cardId: number; question: string; answer: string }

const ENTITIES: Record<string, string> = {
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
}

let settings: Settings = { deck: 'Default', ankiConnectUrl: 'http://localhost:8765' }
let dealing: Promise<void> | null = null
let answering: Promise<unknown> | null = null
let revealedAt = 0

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)

    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
}

export function plain(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\[sound:[^\]]*\]/g, '')
      .replace(/<img\b[^>]*>/gi, '[image]')
      .replace(/<br\s*\/?>|<\/(div|p|li|td|tr|h\d)>/gi, SEP)
      .replace(/<[^>]+>/g, ''),
  )

  return text
    .split(SEP)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(part => part !== '')
    .join(' / ')
}

// the rendered answer repeats the question above <hr id=answer>; keep only what follows it
export function answerSide(html: string): string {
  const parts = html.split(/<hr[^>]*id=["']?answer["']?[^>]*>/i)

  return plain(parts[parts.length - 1] ?? '')
}

export function deckQuery(name: string): string {
  return `"deck:${name.replace(/[\\"*_]/g, '\\$&')}" is:due`
}

function deckName(): string {
  return settings.deck.trim() || 'Default'
}

async function anki<T>($: EngineInterface, action: string, params: object = {}): Promise<T | null> {
  try {
    const res = await $.http.fetch(settings.ankiConnectUrl, {
      method: 'POST',
      body: JSON.stringify({ action, version: 6, params }),
    })
    if (!res.ok) return null
    const { result, error } = JSON.parse(res.text)

    return error ? null : (result as T)
  } catch {
    return null
  }
}

async function goOffline($: EngineInterface): Promise<void> {
  await update($, deck, (): Deck => ({ name: deckName(), status: 'offline', queue: [] }))
  await update($, card, () => null)
}

async function deal($: EngineInterface): Promise<void> {
  await answering

  let queue = (await read($, deck)).queue
  let hasRefilled = false
  let id: number | undefined

  while (id === undefined) {
    if (queue.length === 0) {
      if (hasRefilled) break
      hasRefilled = true
      const ids = await anki<number[]>($, 'findCards', { query: deckQuery(deckName()) })
      if (ids === null) return goOffline($)
      queue = ids
      continue
    }

    const head = queue.slice(0, AREDUE_WINDOW)
    const due = await anki<boolean[]>($, 'areDue', { cards: head })
    if (due === null) return goOffline($)
    const index = due.findIndex(Boolean)
    id = index >= 0 ? head[index] : undefined
    queue = queue.slice(index >= 0 ? index + 1 : head.length)
  }

  if (id === undefined) {
    await update($, deck, (): Deck => ({ name: deckName(), status: 'empty', queue: [] }))
    await update($, card, () => null)
    return
  }

  const info = (await anki<CardInfo[]>($, 'cardsInfo', { cards: [id] }))?.[0]
  if (!info) return goOffline($)

  const next: Card = { id, prompt: plain(info.question) || '(empty)', answer: answerSide(info.answer) || '(empty)' }
  const rest = queue
  await update($, deck, (): Deck => ({ name: deckName(), status: 'ready', queue: rest }))
  await update($, isRevealed, () => false)
  await update($, card, current => current ?? next)
}

async function dealNext($: EngineInterface): Promise<void> {
  dealing ??= deal($).finally(() => {
    dealing = null
  })

  return dealing
}

async function reveal($: EngineInterface): Promise<void> {
  revealedAt = await $.clock.now()
  await update($, isRevealed, () => true)
}

async function answer($: EngineInterface, shown: Card, ease: number): Promise<void> {
  if ((await $.clock.now()) - revealedAt < GRADE_DELAY_MS) return

  let isClaimed = false
  await update($, card, c => {
    isClaimed = c?.id === shown.id
    return isClaimed ? null : c
  })
  if (!isClaimed) return

  const request = anki<boolean[]>($, 'answerCards', { answers: [{ cardId: shown.id, ease }] })
  answering = request
  const ok = await request
  answering = null
  if (ok?.[0]) await update($, reviewed, n => n + 1)
  await dealNext($)
}

export const register: Register = (on, options) => {
  settings = options as Settings

  on('turn.start', async ($, e, next) => {
    if ((await read($, deck)).name !== deckName()) {
      await update($, deck, (): Deck => ({ name: deckName(), status: 'idle', queue: [] }))
      await update($, card, () => null)
    }
    if ((await read($, card)) === null) await dealNext($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !e.props.isWorking) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, card)
    const { status, queue } = await read($, deck)
    const done = await read($, reviewed)
    const title = deckName().toLowerCase()

    if (current === null) {
      if (status === 'offline') return <Text dimColor>  {title} · Anki offline</Text>
      if (status === 'empty') return <Text dimColor>  {title} · nothing due ✓ {done > 0 ? `(${done} today)` : ''}</Text>
      return next(e)
    }

    const shown = await read($, isRevealed)

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        width={Math.min(e.props.bodyColumns, 64)}
      >
        <Box justifyContent="space-between">
          <Text color="cyan" bold>{title}</Text>
          <Text dimColor>{done} today · {queue.length + 1} due</Text>
        </Box>
        <Text bold color="yellow">{current.prompt}</Text>
        {shown
          ? (
            <Box flexDirection="column">
              <Text>→ {current.answer}</Text>
              <Box gap={2}>
                <Button key="again" hotkey="1" plain label="again" onPress={() => answer($, current, EASE.again)} />
                <Button key="good" hotkey="2" plain label="good" onPress={() => answer($, current, EASE.good)} />
                <Button key="easy" hotkey="3" plain label="easy" onPress={() => answer($, current, EASE.easy)} />
              </Box>
            </Box>
          )
          : (
            <Box gap={2}>
              <Text dimColor>→ ···</Text>
              <Button key="show" hotkey="1" plain label="show" onPress={() => reveal($)} />
            </Box>
          )}
      </Box>
    )
  })
}
