import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit } from '../types'

// Bump the shape tag whenever Limit's fields change: it declines old values.
const limits = atom({ plugin: 'usage-pace', key: 'limits' } as const, [], {
  shape: 'limits-1',
})

const STORE_KEY = 'limits-1'
const HOUR = 3_600_000
const DAY = 24 * HOUR

// ---------- window naming ----------------------------------------------------

/** Header windows ("5h", "7d", "7d_fable") → engine-style names. */
function normalizeKind(raw: string): string {
  const k = raw.toLowerCase()
  if (k === '5h') return 'five_hour'
  if (k === '7d') return 'seven_day'
  if (k.startsWith('7d_')) return `seven_day_${k.slice(3)}`
  return k
}

function windowMs(kind: string): number | undefined {
  if (kind.startsWith('five_hour')) return 5 * HOUR
  if (kind.startsWith('seven_day')) return 7 * DAY
  return undefined
}

function label(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'Week'
  if (kind === 'spend_limit') return 'Spend'
  const model = kind.replace(/^seven_day_/, '')
  return model.charAt(0).toUpperCase() + model.slice(1)
}

function rank(kind: string): number {
  if (kind === 'five_hour') return 0
  if (kind === 'seven_day') return 1
  if (kind.includes('fable')) return 2
  if (kind.startsWith('seven_day_')) return 3
  return 4
}

// ---------- pacing math ------------------------------------------------------

type Reading = {
  kind: string
  used: number
  /** Where usage "should" be if spread evenly over the window, 0..100. */
  pace?: number
  /** Usage at reset if the current rate holds, 0..; absent early or unknown. */
  projected?: number
  /** ms until usage reaches 100% at the current rate, when that's before reset. */
  hitsIn?: number
  /** ms until reset. */
  left?: number
  isReset: boolean
}

function evaluate(l: Limit, now: number): Reading {
  const span = windowMs(l.kind)
  const isReset = l.resetsAt !== undefined && now >= l.resetsAt
  const used = isReset ? 0 : l.percentUsed
  if (l.resetsAt === undefined || span === undefined || isReset) {
    return { kind: l.kind, used, isReset }
  }
  const left = l.resetsAt - now
  const elapsed = Math.min(1, Math.max(0, 1 - left / span))
  const r: Reading = { kind: l.kind, used, pace: elapsed * 100, left, isReset }
  // Projections are noise in the first few percent of a window.
  if (elapsed >= 0.08 && used > 0) {
    r.projected = used / elapsed
    const rate = used / (elapsed * span) // percent per ms
    const toFull = (100 - used) / rate
    if (used < 100 && toFull < left) r.hitsIn = toFull
  }
  return r
}

/** Pacing, coolest to hottest. */
type Tone = 'cool' | 'good' | 'warm' | 'hot' | 'over'

const TONE_WORD: Record<Tone, string> = {
  cool: 'plenty of headroom',
  good: 'on pace',
  warm: 'a little hot',
  hot: 'running hot',
  over: 'will run out early',
}

function tone(r: Reading): Tone {
  if (r.used >= 95) return 'over'
  if (r.projected !== undefined) {
    const p = r.projected
    return p <= 70 ? 'cool' : p <= 95 ? 'good' : p <= 110 ? 'warm' : p <= 140 ? 'hot' : 'over'
  }
  if (r.pace !== undefined) {
    // Early in a window: judge by points ahead of pace instead.
    const ahead = r.used - r.pace
    return ahead <= -10 ? 'cool' : ahead <= 2 ? 'good' : ahead <= 8 ? 'warm' : ahead <= 20 ? 'hot' : 'over'
  }
  const u = r.used
  return u < 50 ? 'good' : u < 75 ? 'warm' : u < 90 ? 'hot' : 'over'
}

function fmtLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 10) return `${h}h${String(m % 60).padStart(2, '0')}`
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`
}

// ---------- merging readings -------------------------------------------------

async function merge(
  $: EngineInterface,
  incoming: Limit[],
): Promise<void> {
  if (incoming.length === 0) return
  const next = await update($, limits, list => {
    const byKind = new Map(list.map(l => [l.kind, l]))
    for (const l of incoming) {
      const prev = byKind.get(l.kind)
      // Keep a resetsAt the newer reading lacks (engine and headers differ).
      byKind.set(l.kind, { ...l, resetsAt: l.resetsAt ?? prev?.resetsAt })
    }
    return [...byKind.values()].sort((a, b) => rank(a.kind) - rank(b.kind))
  })
  void $.store.set(STORE_KEY, next).catch(() => undefined)
}

function fromEngine(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  now: number,
): Limit[] {
  return rateLimits.map(r => {
    const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    return {
      kind: normalizeKind(r.kind),
      percentUsed: r.percentUsed,
      resetsAt: Number.isFinite(t) ? t : undefined,
      at: now,
      source: 'engine' as const,
    }
  })
}

const HEADER = /^anthropic-ratelimit-unified-([a-z0-9_]+)-(utilization|reset)$/

function fromHeaders(headers: Record<string, string>, now: number): Limit[] {
  const found = new Map<string, { util?: number; reset?: number }>()
  for (const [name, value] of Object.entries(headers)) {
    const m = HEADER.exec(name.toLowerCase())
    if (!m) continue
    const kind = normalizeKind(m[1] ?? '')
    const slot = found.get(kind) ?? {}
    const n = Number(value)
    if (m[2] === 'utilization' && Number.isFinite(n)) {
      slot.util = n <= 1.5 ? n * 100 : n
    } else if (m[2] === 'reset') {
      const t = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(value)
      if (Number.isFinite(t)) slot.reset = t
    }
    found.set(kind, slot)
  }
  const out: Limit[] = []
  for (const [kind, s] of found) {
    if (s.util === undefined) continue
    out.push({
      kind,
      percentUsed: Math.round(s.util * 10) / 10,
      resetsAt: s.reset,
      at: now,
      source: 'headers',
    })
  }
  return out
}

function isLimitList(v: unknown): v is Limit[] {
  return (
    Array.isArray(v) &&
    v.every(
      x =>
        x &&
        typeof x === 'object' &&
        typeof (x as Limit).kind === 'string' &&
        typeof (x as Limit).percentUsed === 'number',
    )
  )
}

// ---------- plan usage (what the usage page shows, Fable included) -----------

const PLAN_URL = 'https://api.anthropic.com/api/oauth/usage'
const PLAN_MIN_GAP = 2 * 60_000
const PLAN_BACKOFF = 10 * 60_000
let planNextAt = 0
let layoutSeen = ''
// When the hint slot under the prompt last asked to be drawn, per surface.
const hintAskedAt: Record<string, number> = {}

/**
 * The plan's windows from its `limits` list: `session` → five_hour,
 * `weekly_all` → seven_day, and each `weekly_scoped` entry with a model
 * (Fable) → seven_day_<model>. Falls back to the top-level fields.
 */
function fromPlan(body: unknown, now: number): Limit[] {
  if (!body || typeof body !== 'object') return []
  const top = body as Record<string, unknown>
  const found = new Map<string, Limit>()
  const add = (kind: string, pct: unknown, reset: unknown) => {
    if (typeof pct !== 'number' || found.has(kind)) return
    const t = typeof reset === 'string' ? Date.parse(reset) : NaN
    found.set(kind, {
      kind,
      percentUsed: Math.round(pct * 10) / 10,
      resetsAt: Number.isFinite(t) ? t : undefined,
      at: now,
      source: 'plan',
    })
  }

  if (Array.isArray(top.limits)) {
    for (const raw of top.limits) {
      if (!raw || typeof raw !== 'object') continue
      const l = raw as {
        kind?: string
        group?: string
        percent?: unknown
        resets_at?: unknown
        scope?: { model?: { display_name?: unknown; id?: unknown } | null } | null
      }
      const model = l.scope?.model?.display_name ?? l.scope?.model?.id
      if (l.kind === 'session') add('five_hour', l.percent, l.resets_at)
      else if (l.kind === 'weekly_all') add('seven_day', l.percent, l.resets_at)
      else if (l.group === 'weekly' && typeof model === 'string' && model) {
        add(`seven_day_${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, l.percent, l.resets_at)
      }
    }
  }
  for (const kind of ['five_hour', 'seven_day']) {
    const v = top[kind] as { utilization?: unknown; resets_at?: unknown } | null | undefined
    if (v) add(kind, v.utilization, v.resets_at)
  }
  return [...found.values()]
}

/** Up to ~6k characters of the fields Fable may hide in, for diagnosis. */
function sampleOf(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const o = body as Record<string, unknown>
  const pick: Record<string, unknown> = {}
  for (const k of ['limits', 'seven_day_breakdown', 'weekly_scoped_shares', 'pace', 'indicator', 'seven_day_opus', 'seven_day_sonnet']) {
    if (k in o) pick[k] = o[k]
  }
  return JSON.stringify(pick).slice(0, 6000)
}

/** Reads the plan's usage windows with the session's own login, throttled. */
async function refreshPlan($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  if (!force && now < planNextAt) return
  planNextAt = now + PLAN_MIN_GAP
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      planNextAt = Number.POSITIVE_INFINITY // API key / 3P: no plan windows
      return
    }
    const res = await $.http.fetch(PLAN_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    })
    const body: unknown = res.ok ? JSON.parse(res.text) : undefined
    const found = fromPlan(body, now)
    void $.store
      .set('plan-last', {
        at: now,
        status: res.status,
        kinds: body && typeof body === 'object' ? Object.keys(body) : [],
        used: found.map(l => `${l.kind}=${l.percentUsed}`),
        sample: sampleOf(body),
      })
      .catch(() => undefined)
    if (!res.ok) {
      planNextAt = now + PLAN_BACKOFF
      return
    }
    await merge($, found)
  } catch {
    planNextAt = now + PLAN_BACKOFF
  }
}

// ---------- the mod ----------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Last session's readings first, so the band is never blank at start.
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    if (isLimitList(saved) && (await read($, limits)).length === 0) {
      await update($, limits, () => saved)
    }

    const now = await $.clock.now()
    const usage = await $.session.usage().catch(() => undefined)
    if (usage) await merge($, fromEngine(usage.rateLimits, now))

    await $.command.register({
      name: 'usage-pace',
      description: 'Show rate-limit windows, pace and reset times in detail',
    })

    await refreshPlan($, true)

    // Keep the pace marker and countdown moving; re-read the plan every 5 min.
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    $.clock.every(5 * 60_000, () => refreshPlan($))

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await merge($, fromEngine(e.rateLimits, await $.clock.now()))
      void refreshPlan($)
    }
    return next(e)
  })

  // Model responses carry every unified window in their headers, including
  // per-model ones the engine may not surface. Read them; change nothing.
  on('http.fetch', async ($, e, next) => {
    const res = await next(e)
    try {
      const headers = 'value' in res ? res.value?.headers : undefined
      if (headers && next.origin.plugin === 'engine' && /\/v1\/messages/.test(e.url)) {
        const found = fromHeaders(headers, await $.clock.now())
        if (found.length > 0) void merge($, found).catch(() => undefined)
      }
    } catch {
      // Never let the meter get in the way of a model request.
    }
    return res
  })

  on('command.run', { command: 'usage-pace' }, async $ => {
    await refreshPlan($, true)
    const now = await $.clock.now()
    const list = await read($, limits)
    if (list.length === 0) {
      return { text: 'No rate-limit readings yet (they arrive with the first model response, on a subscription).' }
    }
    const lines = list.map(l => {
      const r = evaluate(l, now)
      const pace = r.pace === undefined ? 'n/a' : fmtPct(r.pace)
      const delta =
        r.pace === undefined
          ? ''
          : ` (${r.used - r.pace >= 0 ? '+' : ''}${Math.round(r.used - r.pace)} vs pace)`
      const resets = l.resetsAt ? new Date(l.resetsAt).toLocaleString() : 'unknown'
      const age = fmtLeft(now - l.at)
      const proj = r.projected === undefined ? '' : `, on track for ${fmtPct(r.projected)} at reset`
      const hits = r.hitsIn === undefined ? '' : `, hits 100% in ${fmtLeft(r.hitsIn)}`
      return `${label(l.kind).padEnd(7)} ${fmtPct(r.used).padStart(4)} used, pace ${pace}${delta}${proj}${hits}: ${TONE_WORD[tone(r)]}; resets ${resets}; read ${age} ago via ${l.source} [${l.kind}]`
    })
    return { text: lines.join('\n') }
  })

  // Graphic surfaces (desktop, VS Code, mobile): the meters sit under the
  // prompt box, in the hint line's slot, with the engine's hint kept below.
  on('ui.render', { component: 'PromptHint', plugin: '*' }, async ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    const first = !hintAskedAt[e.surface]
    hintAskedAt[e.surface] = await $.clock.now()
    if (first) {
      void $.store.set('hint-seen', { surface: e.surface, at: hintAskedAt[e.surface], cols: e.viewport?.columns ?? null }).catch(() => undefined)
      // The band above was drawing until now: let it step aside.
      $.ui.invalidate('ui.render')
    }
    const row = await meters($, e, e.viewport?.columns)
    if (!row) return next(e)
    const { Box } = $.ui.resolve(e)
    // The engine's hint (and anything other mods draw there) stays below.
    return (
      <Box flexDirection="column">
        {row}
        {await next(e)}
      </Box>
    )
  })

  // The band above the prompt: always on the terminal (its hint line is one
  // row), and elsewhere until the hint slot under the prompt asks to be drawn.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const asked = hintAskedAt[e.surface]
    if (e.surface !== 'terminal' && asked && (await $.clock.now()) - asked < 10 * 60_000) return next(e)
    return (await meters($, e, e.props.bodyColumns)) ?? next(e)
  })
}

/** The row of meters, or undefined before the first reading on a graphic surface. */
async function meters(
  $: EngineInterface,
  e: { surface: string } & Parameters<EngineInterface['ui']['resolve']>[0],
  columns: number | undefined,
) {
  const list = await read($, limits)
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const isGraphic = e.surface !== 'terminal' && 'Svg' in els

  if (list.length === 0) {
    if (isGraphic) return undefined
    return (
      <Box>
        <Text dimColor>usage · waiting for the first reading</Text>
      </Box>
    )
  }

  const now = await $.clock.now()
  const readings = list.map(l => evaluate(l, now))
  const cols = Math.max(30, columns ?? 90)
  const n = readings.length
  // Text per meter: label, pct (4), reset (5), three 1-cell gaps; plus a
  // 2-cell gap between meters. The bars share what's left.
  const textCells =
    readings.reduce((sum, r) => sum + label(r.kind).length + 12, 0) + 2 * (n - 1)
  const spare = Math.max(0, cols - textCells)
  const barW = Math.max(4, Math.min(16, Math.floor(spare / n)))
  // Graphic surfaces: a cell is ~7px of the band's width.
  const barPx = Math.max(40, Math.min(110, Math.floor((spare * 7) / n) - 4))
  if (layoutSeen !== `${e.surface}:${cols}`) {
    layoutSeen = `${e.surface}:${cols}`
    void $.store.set('layout', { surface: e.surface, cols, barPx, barW }).catch(() => undefined)
  }

  return (
    <Box flexDirection="row" flexWrap="nowrap" justifyContent="center" width="100%" columnGap={2} overflow="hidden">
      {readings.map(r => meter(r, isGraphic ? { px: barPx } : { cells: barW }, els))}
    </Box>
  )
}

// ---------- drawing ----------------------------------------------------------

type Els = ReturnType<EngineInterface['ui']['resolve']>

const HEX: Record<Tone, string> = {
  cool: '#4c9bf5',
  good: '#3fb950',
  warm: '#d4b22c',
  hot: '#f0883e',
  over: '#f85149',
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/**
 * A thin bar: grey track, a faint "budget so far" band up to the pace point,
 * the coloured fill on top, and a caret above the track marking pace.
 */
function barSvg(r: Reading, W: number): string {
  const H = 16
  const y = 9 // track sits below the caret, with a 2.5px gap
  const t = 5 // track thickness
  const fill = clamp01(r.used / 100) * W
  const pace = r.pace === undefined ? undefined : clamp01(r.pace / 100) * W
  const c = HEX[tone(r)]
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect x="0" y="${y}" width="${W}" height="${t}" rx="${t / 2}" fill="#8b949e" fill-opacity="0.22"/>`,
  ]
  if (pace !== undefined && pace > 0) {
    parts.push(
      `<rect x="0" y="${y}" width="${pace.toFixed(1)}" height="${t}" rx="${t / 2}" fill="#8b949e" fill-opacity="0.38"/>`,
    )
  }
  if (fill > 0) {
    parts.push(
      `<rect x="0" y="${y}" width="${Math.max(t, fill).toFixed(1)}" height="${t}" rx="${t / 2}" fill="${c}"/>`,
    )
  }
  if (pace !== undefined) {
    // A caret above the track pointing down at the pace point; it never
    // touches the bar. Mid-grey reads on both light and dark backgrounds.
    const xn = Math.max(3.5, Math.min(W - 3.5, pace))
    const tri = `M${(xn - 3.5).toFixed(1)} 1 L${(xn + 3.5).toFixed(1)} 1 L${xn.toFixed(1)} 6.5 Z`
    parts.push(`<path d="${tri}" fill="#8b949e" stroke="#8b949e" stroke-width="1" stroke-linejoin="round"/>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

function textBar(r: Reading, W: number, { Box, Text }: Els) {
  const color = HEX[tone(r)]
  const fill = Math.max(0, Math.min(W, Math.round((r.used / 100) * W)))
  const mark =
    r.pace === undefined ? -1 : Math.max(0, Math.min(W - 1, Math.floor((r.pace / 100) * W)))
  const runs: { ch: string; color?: string; dim?: boolean }[] = []
  for (let i = 0; i < W; i++) {
    const cell =
      i === mark
        ? { ch: '╋', color: 'text' }
        : i < fill
          ? { ch: '━', color }
          : { ch: '─', color: 'subtle', dim: true }
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color && last.dim === cell.dim && cell.ch === last.ch.charAt(0)) {
      last.ch += cell.ch
    } else {
      runs.push({ ...cell })
    }
  }
  return (
    <Box flexDirection="row">
      {runs.map(run => (
        <Text mono color={run.color} dimColor={run.dim}>
          {run.ch}
        </Text>
      ))}
    </Box>
  )
}

function meter(r: Reading, size: { px: number } | { cells: number }, els: Els) {
  const { Box, Text } = els
  const t = tone(r)
  const color = HEX[t]
  const ahead = r.pace === undefined ? undefined : Math.round(r.used - r.pace)
  const alt =
    `${label(r.kind)} ${fmtPct(r.used)} used` +
    (r.pace === undefined || ahead === undefined
      ? ''
      : `, pace ${fmtPct(r.pace)} (${ahead > 0 ? '+' : ''}${ahead})`) +
    `, ${TONE_WORD[t]}`

  let bar
  if ('px' in size && 'Svg' in els && els.Svg) {
    const Svg = els.Svg
    bar = <Svg source={barSvg(r, size.px)} alt={alt} width={size.px} height={16} />
  } else {
    bar = textBar(r, 'cells' in size ? size.cells : 12, els)
  }

  return (
    <Box key={r.kind} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
      <Text bold dimColor={r.isReset}>
        {label(r.kind)}
      </Text>
      {bar}
      <Text tabular color={color} bold>
        {fmtPct(r.used)}
      </Text>
      {r.hitsIn !== undefined ? (
        <Text color={color}>⚠{fmtLeft(r.hitsIn)}</Text>
      ) : (
        r.left !== undefined && <Text dimColor>↻{fmtLeft(r.left)}</Text>
      )}
    </Box>
  )
}
