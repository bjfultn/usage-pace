import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-19T12:00:00Z')

const BAND = {
  plugin: 'usage-pace',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

// Graphic surfaces draw the meters in the hint slot under the prompt.
const HINT = {
  plugin: 'usage-pace',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '' },
  viewport: { columns: 120, rows: 40 },
} as const
const at = (surface: 'terminal' | 'desktop' | 'mobile', columns = 120) =>
  surface === 'terminal'
    ? { ...BAND, props: { ...BAND.props, bodyColumns: columns }, surface }
    : { ...HINT, viewport: { ...HINT.viewport, columns }, surface }

test('draws 5h, Week and Fable meters with pace deltas', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: {} as never,
    changed: ['rateLimits'],
    rateLimits: [
      // 5h window, 2.5h elapsed (pace 50%), 70% used → +20, red
      { kind: 'five_hour', percentUsed: 70, resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString() },
      // week, 3.5d elapsed (pace 50%), 30% used → −20
      { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 3.5 * 86_400_000).toISOString() },
      { kind: 'seven_day_fable', percentUsed: 55, resetsAt: new Date(NOW + 3.5 * 86_400_000).toISOString() },
    ],
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount(at(surface))
    expect((await ui.find({ type: 'Text', text: /^5h$/ }))?.text).toBe('5h')
    expect((await ui.find({ type: 'Text', text: /^Week$/ }))?.text).toBe('Week')
    expect((await ui.find({ type: 'Text', text: /^Fable$/ }))?.text).toBe('Fable')
    expect((await ui.find({ type: 'Text', text: /^70%$/ }))?.text).toBe('70%')
    // The points-ahead figure lives in the bar's label now, not the row.
    expect(await ui.find({ type: 'Text', text: /^\+20$/ })).toBeFalsy()
    // 70% used halfway through: runs out in ~64 min, before the 2h30 reset.
    expect((await ui.find({ type: 'Text', text: /^⚠1h04$/ }))?.text).toBe('⚠1h04')
    expect((await ui.find({ type: 'Text', text: /^↻4d$/ }))?.text).toBe('↻4d')
    await ui.unmount()
  }
})

test('shows a quiet placeholder before any reading', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  const ui = await $.ui.mount(at('terminal'))
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/waiting/)
  await ui.unmount()
})

test('a window past its reset reads 0%', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: {} as never,
    changed: ['rateLimits'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: 88, resetsAt: new Date(NOW - 60_000).toISOString() },
    ],
  })
  const ui = await $.ui.mount(at('terminal'))
  expect((await ui.find({ type: 'Text', text: /^0%$/ }))?.text).toBe('0%')
  await ui.unmount()
})

test('reads Fable from the plan usage endpoint and draws thin SVG bars on desktop', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {} as never, rateLimits: [] } }))
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  const seen: string[] = []
  on('http.fetch', (_, e) => {
    seen.push(e.url)
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          five_hour: { utilization: 19, resets_at: new Date(NOW + 1.5 * 3_600_000).toISOString() },
          seven_day: { utilization: 4, resets_at: new Date(NOW + 5 * 86_400_000).toISOString() },
          seven_day_oauth_apps: { utilization: 0, resets_at: null },
          seven_day_opus: null,
          limits: [
            { kind: 'session', group: 'session', percent: 19, resets_at: new Date(NOW + 1.5 * 3_600_000).toISOString(), scope: null },
            { kind: 'weekly_all', group: 'weekly', percent: 4, resets_at: new Date(NOW + 5 * 86_400_000).toISOString(), scope: null },
            { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: new Date(NOW + 5 * 86_400_000).toISOString(), scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
          ],
        }),
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(seen).toContain('https://api.anthropic.com/api/oauth/usage')

  const ui = await $.ui.mount(at('desktop'))
  expect((await ui.find({ type: 'Text', text: /^Fable$/ }))?.text).toBe('Fable')
  expect((await ui.find({ type: 'Text', text: /^5%$/ }))?.text).toBe('5%')
  expect(await ui.find({ type: 'Text', text: /^Oauth_apps$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Opus$/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^↻5d$/ }))?.text).toBe('↻5d')
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeTruthy()
  await ui.unmount()

  // The terminal keeps the glyph bar.
  const term = await $.ui.mount(at('terminal'))
  expect(await term.find({ type: 'Svg' })).toBeFalsy()
  expect((await term.find({ type: 'Text', text: /╋/ }))?.text).toContain('╋')
  await term.unmount()
})

test('colors follow pacing, and a hot window warns when it will run out', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const iso = (ms: number) => new Date(NOW + ms).toISOString()
  await $.session.measure({
    context: {} as never,
    changed: ['rateLimits'],
    rateLimits: [
      // 5h, half elapsed, 80% used → projected 160%: hits 100% in 37.5 min
      { kind: 'five_hour', percentUsed: 80, resetsAt: iso(2.5 * 3_600_000) },
      // week, half elapsed, 20% used → projected 40%: plenty of headroom
      { kind: 'seven_day', percentUsed: 20, resetsAt: iso(3.5 * 86_400_000) },
    ],
  })
  const ui = await $.ui.mount(at('desktop'))
  expect((await ui.find({ type: 'Text', text: /^⚠38m$/ }))?.text).toBe('⚠38m')
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(2)
  expect(String(svgs[0]?.props.alt)).toMatch(/will run out early/)
  expect(String(svgs[0]?.props.source)).toContain('#f85149')
  expect(String(svgs[1]?.props.alt)).toMatch(/plenty of headroom/)
  expect(String(svgs[1]?.props.source)).toContain('#4c9bf5')
  await ui.unmount()
})

test('three meters fit one row even in a narrow band', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const iso = (ms: number) => new Date(NOW + ms).toISOString()
  await $.session.measure({
    context: {} as never,
    changed: ['rateLimits'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: iso(3_600_000) },
      { kind: 'seven_day', percentUsed: 4, resetsAt: iso(5 * 86_400_000) },
      { kind: 'seven_day_fable', percentUsed: 6, resetsAt: iso(5 * 86_400_000) },
    ],
  })
  for (const bodyColumns of [70, 160]) {
    const ui = await $.ui.mount(at('desktop', bodyColumns))
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBe(3)
    const px = Number(svgs[0]?.props.width)
    expect(px).toBeGreaterThanOrEqual(40)
    expect(px).toBeLessThanOrEqual(110)
    await ui.unmount()
  }
})

test('desktop draws under the prompt and keeps the engine hint; the band above stays empty', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: {} as never,
    changed: ['rateLimits'],
    rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: new Date(NOW + 3_600_000).toISOString() }],
  })
  // Until the slot under the prompt asks, the band above draws them.
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await before.find({ type: 'Svg' })).toBeTruthy()
  await before.unmount()
  const hint = await $.ui.mount({ ...HINT, props: { ...HINT.props, hint: 'esc to interrupt' }, surface: 'desktop' })
  expect(await hint.find({ type: 'Svg' })).toBeTruthy()
  await hint.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Svg' })).toBeFalsy()
  await band.unmount()
})
