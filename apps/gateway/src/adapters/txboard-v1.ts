import { asRecord } from '../services/upstream.js'

/**
 * adapters/txboard-v1.ts — TXBoard v1 upstream payload -> public Gateway DTO.
 *
 * Every function here is a PURE transformation: no I/O, no config access, no
 * clock, no randomness. None of them returns a raw internal upstream field to
 * a theme client — the allowlist of exposed fields is the security boundary.
 * The public JSON shape of every DTO is contract-frozen (see
 * contracts/gateway-v1.md); renaming or adding fields is a breaking change.
 */

/** Public theme reference. Only the two display fields survive. */
export type PublicTheme = { name: string; config: Record<string, unknown> }

export function toPublicTheme(data: unknown): PublicTheme {
  const config = asRecord(data)
  return {
    name: typeof config.frontend_theme === 'string' && config.frontend_theme ? config.frontend_theme : 'TXBoard',
    config: asRecord(config.theme_config),
  }
}

export type PublicCaptcha = { enabled: boolean; type: 'turnstile' | 'recaptcha' | 'recaptcha-v3' | null; siteKey: string | null }

/**
 * Only TXBoard guest/comm/config public CAPTCHA metadata may reach theme
 * clients. CaptchaService in Laravel remains responsible for checking
 * submitted tokens; secret keys never pass through this adapter.
 */
export function toPublicCaptcha(data: Record<string, unknown>): PublicCaptcha {
  const enabled = data.is_captcha === true || data.is_captcha === 1 || data.is_captcha === '1'
  if (!enabled) return { enabled: false, type: null, siteKey: null }
  const candidate = data.captcha_type
  const type = candidate === 'turnstile' || candidate === 'recaptcha' || candidate === 'recaptcha-v3'
    ? candidate : null
  const key = type === 'turnstile' ? data.turnstile_site_key
    : type === 'recaptcha-v3' ? data.recaptcha_v3_site_key
    : type === 'recaptcha' ? data.recaptcha_site_key : null
  return {
    enabled: true,
    type,
    siteKey: typeof key === 'string' && key.trim() ? key : null,
  }
}

export type PublicSite = { name: string; description: string; url: string; logo: string }

export function toPublicSite(data: Record<string, unknown>): PublicSite {
  return {
    name: typeof data.app_name === 'string' ? data.app_name : 'TXBoard',
    description: typeof data.app_description === 'string' ? data.app_description : '',
    url: typeof data.app_url === 'string' ? data.app_url : '',
    logo: typeof data.logo === 'string' ? data.logo : '',
  }
}

export type PublicPaymentMethod = {
  id: number
  name: string
  icon: string | null
  payment: string | null
  handlingFeeFixed: number
  handlingFeePercent: number
}

type RawPaymentMethod = {
  id: number
  name: string
  icon?: unknown
  payment?: unknown
  handling_fee_fixed?: unknown
  handling_fee_percent?: unknown
}

/** Only display fields; no provider configs, credentials or payment URLs. */
export function toPublicPaymentMethods(methods: readonly RawPaymentMethod[]): PublicPaymentMethod[] {
  return methods.map(m => ({
    id: m.id,
    name: m.name,
    icon: typeof m.icon === 'string' ? m.icon : null,
    payment: typeof m.payment === 'string' ? m.payment : null,
    handlingFeeFixed: typeof m.handling_fee_fixed === 'number' ? m.handling_fee_fixed : 0,
    handlingFeePercent: typeof m.handling_fee_percent === 'number' ? m.handling_fee_percent : 0,
  }))
}

export type PublicSubscriptionSummary = {
  planId: number | null
  planName: string | null
  expiredAt: number | null
  upload: number | null
  download: number | null
  transferEnable: number | null
  resetDay: number | null
  deviceLimit: number | null
  speedLimit: number | null
}

/**
 * TXBoard getSubscribe includes the user token, UUID and subscribe_url. This
 * endpoint is safe for an account overview, NOT a full subscription export —
 * those three fields are deliberately dropped here.
 */
export function toPublicSubscriptionSummary(data: Record<string, unknown>): PublicSubscriptionSummary {
  const optionalNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
  const plan = asRecord(data.plan)
  return {
    planId: optionalNumber(data.plan_id),
    planName: typeof plan.name === 'string' ? plan.name : null,
    expiredAt: optionalNumber(data.expired_at),
    upload: optionalNumber(data.u),
    download: optionalNumber(data.d),
    transferEnable: optionalNumber(data.transfer_enable),
    resetDay: optionalNumber(data.reset_day),
    deviceLimit: optionalNumber(data.device_limit),
    speedLimit: optionalNumber(data.speed_limit),
  }
}

export type PublicDashboardStats = { unpaidOrders: number; openTickets: number; invitedUsers: number }

/** The upstream tuple has no field names; positions are the contract. */
export function toPublicDashboardStats(counts: readonly [number, number, number]): PublicDashboardStats {
  return { unpaidOrders: counts[0], openTickets: counts[1], invitedUsers: counts[2] }
}

export type PublicOrderStatus = { tradeNo: string; status: number }

export function toPublicOrderStatus(tradeNo: string, status: number): PublicOrderStatus {
  return { tradeNo, status }
}
