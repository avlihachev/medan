import { describe, expect, mock, test } from 'claude-code/testing'

import { answerSide, deckQuery, gradeButtons, hotkey, plain, shuffled } from '../hooks/register'

type Call = { action: string; params: Record<string, unknown> }

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

const CARDS: Record<number, { question: string; answer: string }> = {
  11: {
    question: '<style>.card{}</style>att förhandla',
    answer: '<style>.card{}</style>att förhandla\n\n<hr id=answer>\n\nвести&nbsp;переговоры',
  },
  12: {
    question: '<div>понятие</div>',
    answer: '<div>понятие</div>\n\n<hr id="answer">\n\nett begrepp<br>[sound:begrepp.mp3]',
  },
}

type Anki = { isOnline?: boolean; notDue?: number[]; learning?: number[]; reviews?: number[] }

function fakeAnki(calls: Call[], anki: Anki = {}) {
  const { isOnline = true, notDue = [], learning = [11, 12], reviews = [] } = anki
  const answered: number[] = []
  const findCards = (query: string) =>
    query.endsWith(' -is:learn') ? reviews
    : query.endsWith(' is:learn') ? learning
    : query.endsWith(' rated:1') ? answered
    : [...learning, ...reviews].filter(id => !notDue.includes(id) && !answered.includes(id))
  return async (_$: unknown, e: { url: string; init?: { body?: string } }) => {
    if (!isOnline) return { deny: 'ECONNREFUSED' }
    const call = JSON.parse(e.init?.body ?? '{}') as Call
    calls.push(call)
    const cards = (call.params.cards ?? []) as number[]
    const result =
      call.action === 'findCards' ? findCards(String(call.params.query))
      : call.action === 'areDue' ? cards.map(id => !notDue.includes(id))
      : call.action === 'cardsInfo' ? cards.map(id => ({ cardId: id, ...(CARDS[id] ?? { question: `q${id}`, answer: `q${id}<hr id=answer>a${id}` }) }))
      : call.action === 'answerCards' ? (answered.push(...(call.params.answers as { cardId: number }[]).map(a => a.cardId)), [true])
      : null
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ result, error: null }) } }
  }
}

const SVENSK = { options: { deck: 'Svensk' } }

function answers(calls: Call[]) {
  return calls.filter(c => c.action === 'answerCards').map(c => c.params)
}

describe('register', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`reveals and answers a due card on ${surface}`, SVENSK, async ($, on) => {
      const calls: Call[] = []
      mock.clock(on, { now: 1000 })
      on('turn.start', (_$, e) => ({ turnId: e.turnId }))
      on('http.fetch', fakeAnki(calls))
      await $.turn.start({ text: 'hej', turnId: 't1' })

      expect(calls.slice(0, 2).map(c => c.params)).toEqual([
        { query: '"deck:Svensk" is:due is:learn' },
        { query: '"deck:Svensk" is:due -is:learn' },
      ])
      const ui = await $.ui.mount({ plugin: 'medan', surface, component: 'AbovePrompt', props: PROPS })
      expect(await ui.find({ type: 'Text', text: 'svensk' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
      expect(await ui.find({ text: /вести переговоры/ })).toBeUndefined()

      await ui.press({ key: 'show' })
      expect(await ui.find({ type: 'Text', text: '→ вести переговоры' })).toBeDefined()

      expect(await ui.find({ key: 'good' })).toBeUndefined()
      await ui.press({ key: 'easy' })
      expect(answers(calls)).toEqual([{ answers: [{ cardId: 11, ease: 4 }] }])
      expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 today · 1 due/ })).toBeDefined()

      await ui.press({ key: 'show' })
      expect(await ui.find({ type: 'Text', text: '→ ett begrepp' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('with show and again on the same key, a double tap does not answer "again"', { options: { deck: 'Svensk', againKey: '1' } }, async ($, on) => {
    const calls: Call[] = []
    const clock = mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'again' })
    expect(answers(calls)).toEqual([])

    await clock.advance(500)
    await Promise.all([ui.press({ key: 'easy' }), ui.press({ key: 'easy' })])
    expect(answers(calls)).toHaveLength(1)
    await ui.unmount()
  })

  test('skips cards no longer due past the first window', SVENSK, async ($, on) => {
    const calls: Call[] = []
    const ids = Array.from({ length: 25 }, (_, i) => 100 + i)
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki(calls, { learning: ids, notDue: ids.slice(0, 22) }))
    await $.turn.start({ text: 'hej', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'q122' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 due/ })).toBeDefined()
    await ui.unmount()
  })

  test('a card left unopened for a whole turn goes to the back of the queue', SVENSK, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki([]))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()

    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()

    await ui.press({ key: 'show' })
    await $.turn.start({ text: 'and again', turnId: 't3' })
    expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
    await ui.unmount()
  })

  test('deals learning cards before the review backlog', SVENSK, async ($, on) => {
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki([], { learning: [12], reviews: [11] }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
    await ui.unmount()
  })

  test('counts come from Anki, so reviews done elsewhere show up', SVENSK, async ($, on) => {
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki([], { learning: [11, 12, 13], notDue: [13] }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '0 today · 2 due' })).toBeDefined()
    await ui.unmount()
  })

  test('says nothing is due when every card was reviewed elsewhere', SVENSK, async ($, on) => {
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki([], { notDue: [11, 12] }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /svensk · nothing due/ })).toBeDefined()
    await ui.unmount()
  })

  test('stays out of the way between turns', SVENSK, async ($, on) => {
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki([]))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, isWorking: false } })
    expect(await ui.find({ text: /att förhandla/ })).toBeUndefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  })

  test('says Anki is offline instead of failing', SVENSK, async ($, on) => {
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki([], { isOnline: false }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'medan', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /svensk · Anki offline/ })).toBeDefined()
    await ui.unmount()
  })

  test('reviews the Default deck when none is configured', async ($, on) => {
    const calls: Call[] = []
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('http.fetch', fakeAnki(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    expect(calls[0]?.params).toEqual({ query: '"deck:Default" is:due is:learn' })
  })
})

describe('keys', () => {
  test('default layout is show 1, again 2, easy 3', async () => {
    const defaults = { deck: 'Default', ankiConnectUrl: '', showKey: '1', againKey: '2', hardKey: '', goodKey: '', easyKey: '3' }
    expect(gradeButtons(defaults).map(g => `${g.key}:${g.name}`)).toEqual(['2:again', '3:easy'])
  })

  test('rejects keys the engine would refuse and drops duplicates', async () => {
    expect(hotkey(' ')).toBeUndefined()
    expect(hotkey('space')).toBeUndefined()
    expect(hotkey('E')).toBe('e')
    const keys = { deck: '', ankiConnectUrl: '', showKey: '1', againKey: '2', hardKey: '2', goodKey: '!', easyKey: 'e' }
    expect(gradeButtons(keys).map(g => `${g.key}:${g.name}`)).toEqual(['2:again', 'e:easy'])
  })
})

describe('text', () => {
  test('shuffled keeps every card exactly once', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => i)
    expect([...shuffled(ids)].sort((a, b) => a - b)).toEqual(ids)
  })

  test('escapes Anki search syntax in deck names', async () => {
    expect(deckQuery('Svensk::Verb')).toBe('"deck:Svensk::Verb" is:due')
    expect(deckQuery('my_deck*')).toBe('"deck:my\\_deck\\*" is:due')
    expect(deckQuery('a "b" \\c')).toBe('"deck:a \\"b\\" \\\\c" is:due')
  })

  test('keeps slashes and decodes entities', async () => {
    expect(plain('see http://x.com/a/ and /etc')).toBe('see http://x.com/a/ and /etc')
    expect(plain('it&#x27;s &mdash; &#8212; &apos;ok&apos; &amp;lt;')).toBe("it's — — 'ok' &lt;")
    expect(plain('<ul><li>a</li><li>b</li></ul>')).toBe('a / b')
    expect(plain('<img src="x.png">')).toBe('[image]')
  })

  test('takes the part after the answer rule, or the whole side when there is none', async () => {
    expect(answerSide('q<hr id=answer>a')).toBe('a')
    expect(answerSide('{{c1::a}} is <span class=cloze>a</span>')).toBe('{{c1::a}} is a')
  })
})
