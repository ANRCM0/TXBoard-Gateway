/**
 * services/metrics.ts — a dependency-free Prometheus registry (GW-214).
 *
 * The text exposition format is implemented with the Node standard library
 * only: no prom-client, no new runtime dependency. Two invariants are enforced
 * at write time rather than at scrape time:
 *
 *  1. Label NAMES come from a fixed, compile-time list per metric, so a
 *     request can never invent a label and explode the series cardinality.
 *  2. Label VALUES are constrained to a bounded, non-user-data alphabet. The
 *     `operation` label is always a route TEMPLATE with path parameters
 *     collapsed to `:id` (see ../middleware/observability.ts), never a raw
 *     path, so user identifiers can not become metric labels.
 */

export type MetricLabels = Readonly<Record<string, string>>

const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/
/** Bounded, printable, quote/backslash-free label value alphabet. */
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9_./:@-]{0,128}$/
const REDACTED = 'redacted'

/** Sanitize a label value. Anything outside the safe alphabet collapses. */
export function sanitizeLabelValue(value: string): string {
  const bounded = value.slice(0, 128)
  return LABEL_VALUE_PATTERN.test(bounded) ? bounded : REDACTED
}

/** Prometheus float rendering without exponent notation. */
export function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(6)))
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

type SeriesEntry = { labels: Record<string, string>; value: number }

/** Renders `{name="value",...}` from an ordered label record. */
function renderLabels(labels: Record<string, string>): string {
  const names = Object.keys(labels)
  if (names.length === 0) return ''
  return `{${names.map(n => `${n}="${labels[n]}"`).join(',')}}`
}

abstract class Metric {
  protected readonly series = new Map<string, SeriesEntry>()
  /** Prometheus metric family name suffix: `counter`, `gauge`, `histogram`. */
  protected family: string

  constructor(
    readonly name: string,
    readonly help: string,
    family: string,
    readonly labelNames: readonly string[],
  ) {
    this.family = family
  }

  /** Stable series key from the declared label order, with sanitized values. */
  protected keyOf(labels: MetricLabels): string {
    return this.labelNames
      .map(name => `${name}="${sanitizeLabelValue(labels[name] ?? '')}"`)
      .join(',')
  }

  /** The full label record for a series, in declaration order. */
  protected labelsOf(labels: MetricLabels): Record<string, string> {
    const out: Record<string, string> = {}
    for (const name of this.labelNames) out[name] = sanitizeLabelValue(labels[name] ?? '')
    return out
  }

  protected header(): string {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.family}`
  }

  /** Series in a stable, deterministic order so scrapes are reproducible. */
  protected sortedSeries(): SeriesEntry[] {
    return [...this.series.values()].sort((a, b) => this.keyOf(a.labels).localeCompare(this.keyOf(b.labels)))
  }

  /** Every concrete metric renders its own samples; shared bits are helpers. */
  abstract render(): string

  reset(): void {
    this.series.clear()
  }
}

/** Monotonically increasing counter (also the shape used for gauges). */
export class Counter extends Metric {
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, 'counter', labelNames)
  }

  inc(labels: MetricLabels = {}, value = 1): void {
    if (!Number.isFinite(value)) return
    const key = this.keyOf(labels)
    const existing = this.series.get(key)
    if (existing) existing.value += value
    else this.series.set(key, { labels: this.labelsOf(labels), value })
  }

  get(labels: MetricLabels = {}): number {
    return this.series.get(this.keyOf(labels))?.value ?? 0
  }

  render(): string {
    const lines = this.sortedSeries().map(
      ({ labels, value }) => `${this.name}${renderLabels(labels)} ${formatMetricValue(value)}`,
    )
    return [this.header(), ...lines].join('\n')
  }
}

/** Gauge: the last value written wins. */
export class Gauge extends Counter {
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, labelNames)
    this.family = 'gauge'
  }

  set(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) return
    this.series.set(this.keyOf(labels), { labels: this.labelsOf(labels), value })
  }
}

type HistogramSeries = SeriesEntry & { buckets: number[]; sum: number }

/** Cumulative histogram with a fixed bucket set (seconds). */
export class Histogram extends Metric {
  private readonly buckets: readonly number[]

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ) {
    super(name, help, 'histogram', labelNames)
    this.buckets = [...buckets, Number.POSITIVE_INFINITY]
  }

  observe(labels: MetricLabels, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return
    const key = this.keyOf(labels)
    let entry = this.series.get(key) as HistogramSeries | undefined
    if (!entry) {
      entry = { labels: this.labelsOf(labels), value: 0, buckets: new Array(this.buckets.length).fill(0), sum: 0 }
      this.series.set(key, entry)
    }
    entry.value += 1
    entry.sum += seconds
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]!) entry.buckets[i]! += 1
    }
  }

  render(): string {
    const lines: string[] = [this.header()]
    for (const entry of this.sortedSeries() as HistogramSeries[]) {
      for (let i = 0; i < this.buckets.length; i++) {
        const le = Number.isFinite(this.buckets[i]!) ? String(this.buckets[i]) : '+Inf'
        lines.push(`${this.name}_bucket${renderLabels({ ...entry.labels, le })} ${formatMetricValue(entry.buckets[i] ?? 0)}`)
      }
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${formatMetricValue(entry.sum)}`)
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${formatMetricValue(entry.value)}`)
    }
    return lines.join('\n')
  }
}

/** Latency bucket boundaries in seconds (plus +Inf, appended internally). */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

/**
 * The Gateway metric set (GW-214). Every label is a bounded enum: the
 * `operation` label is a collapsed route template, `status_class` is 2xx/3xx/
 * 4xx/5xx/unknown, `reason`/`dependency` are closed vocabularies. No label can
 * ever carry a user identifier, token, email, IP or URL.
 */
export class MetricsRegistry {
  /** Requests served, by route template / method / status class. */
  readonly requests = new Counter(
    'txboard_gateway_requests_total',
    'Requests served by the Gateway, labelled by route template, method and status class.',
    ['operation', 'method', 'status_class'],
  )

  /** End-to-end request duration (gateway + upstream). */
  readonly requestDuration = new Histogram(
    'txboard_gateway_request_duration_seconds',
    'End-to-end request duration in seconds.',
    ['operation', 'method', 'status_class'],
    DURATION_BUCKETS,
  )

  /** Upstream call duration only. */
  readonly upstreamDuration = new Histogram(
    'txboard_gateway_upstream_duration_seconds',
    'Upstream (Laravel) call duration in seconds.',
    ['operation'],
    DURATION_BUCKETS,
  )

  /** Upstream calls that hit the configured timeout. */
  readonly upstreamTimeouts = new Counter(
    'txboard_gateway_upstream_timeouts_total',
    'Upstream calls that exceeded the configured timeout.',
    ['operation'],
  )

  /** Upstream calls that failed before a response was produced. */
  readonly upstreamFailures = new Counter(
    'txboard_gateway_upstream_failures_total',
    'Upstream calls that failed before a response was produced.',
    ['operation', 'reason'],
  )

  /** Requests rejected with 429 (route limiter, login protection or upstream). */
  readonly rateLimited = new Counter(
    'txboard_gateway_rate_limited_total',
    'Requests rejected with HTTP 429.',
    ['operation'],
  )

  /** Requests answered with a 5xx status. */
  readonly serverErrors = new Counter(
    'txboard_gateway_server_errors_total',
    'Requests answered with a 5xx status.',
    ['operation', 'status_class'],
  )

  /** Redis-backed safety store reachability (1 = up, 0 = down). */
  readonly redisUp = new Gauge(
    'txboard_gateway_redis_up',
    'Redis-backed safety store reachability.',
    ['dependency'],
  )

  /** Redis-backed store failures observed on the request path. */
  readonly redisErrors = new Counter(
    'txboard_gateway_redis_errors_total',
    'Redis-backed safety store failures observed on the request path.',
    ['dependency'],
  )

  /** Frozen contract version currently served. */
  readonly contractVersion = new Gauge(
    'txboard_gateway_contract_version',
    'Gateway contract version currently served.',
    ['version'],
  )

  /* ---------------- GW-206 resilience families (see middleware/resilience.ts) ------- */

  /** Circuit breaker state: 0 closed, 1 half-open, 2 open. */
  readonly breakerState = new Gauge(
    'txboard_gateway_circuit_breaker_state',
    'Upstream circuit breaker state: 0 closed, 1 half-open, 2 open.',
    [],
  )

  /** Circuit breaker state changes, labelled by the transition. */
  readonly breakerTransitions = new Counter(
    'txboard_gateway_circuit_breaker_transitions_total',
    'Upstream circuit breaker state transitions.',
    ['from', 'to'],
  )

  /** Requests shed with 503 at the queue edge by the overload guard. */
  readonly overloadRejections = new Counter(
    'txboard_gateway_overload_rejections_total',
    'Requests rejected at the queue edge with 503 to shed excess load.',
    [],
  )

  /** Time a request spent waiting in the overload queue (seconds). */
  readonly queueWait = new Histogram(
    'txboard_gateway_queue_wait_seconds',
    'Time a request spent waiting for a concurrency slot.',
    [],
    DURATION_BUCKETS,
  )

  /** Retried upstream calls, labelled by the retried operation. */
  readonly upstreamRetries = new Counter(
    'txboard_gateway_upstream_retries_total',
    'Idempotent upstream calls that were retried after a transport failure.',
    ['operation'],
  )

  /** Public reads served from the stale cache while the upstream is broken. */
  readonly staleServed = new Counter(
    'txboard_gateway_stale_served_total',
    'Public read requests served from the stale cache after upstream failure.',
    ['operation'],
  )

  /** Requests rejected by the local fallback quota during a Redis outage. */
  readonly localQuotaRejections = new Counter(
    'txboard_gateway_local_quota_rejections_total',
    'Requests rejected by the strict per-instance local quota used during a Redis outage.',
    [],
  )

  /** Safety-store degradations, labelled by action and outage policy. */
  readonly redisDegraded = new Counter(
    'txboard_gateway_redis_degraded_total',
    'Safety-store degradations by action and Redis outage policy.',
    ['operation', 'policy'],
  )

  private all(): Metric[] {
    return [
      this.requests, this.requestDuration, this.upstreamDuration, this.upstreamTimeouts,
      this.upstreamFailures, this.rateLimited, this.serverErrors, this.redisUp,
      this.redisErrors, this.contractVersion, this.breakerState, this.breakerTransitions,
      this.overloadRejections, this.queueWait, this.upstreamRetries, this.staleServed,
      this.localQuotaRejections, this.redisDegraded,
    ]
  }

  reset(): void {
    for (const metric of this.all()) metric.reset()
  }

  /** Prometheus text exposition format (version 0.0.4). */
  render(): string {
    return this.all().map(metric => metric.render()).join('\n') + '\n'
  }
}

/** Create an isolated registry (used by tests and embedders). */
export function createMetricsRegistry(): MetricsRegistry {
  return new MetricsRegistry()
}

/** Assert a label name is well formed; guards programmer error, not user input. */
export function isValidLabelName(name: string): boolean {
  return LABEL_NAME_PATTERN.test(name)
}
