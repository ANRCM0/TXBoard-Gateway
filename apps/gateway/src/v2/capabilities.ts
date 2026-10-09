/**
 * v2/capabilities.ts — the v2 capability list generator.
 *
 * `bootstrap.capabilities` is how a client discovers what this Gateway
 * deployment exposes. The v2 list is derived from GATEWAY_V2_FEATURES (the
 * deployment's enabled feature flags) plus a small set of always-on
 * capabilities, so a capability a deployment did not enable is simply absent —
 * a client must never see a capability it cannot call.
 *
 * PR1 exposes no business capabilities: the only v2 route is the local health
 * probe. The generator exists now, wired to the feature flags, so later PRs
 * add their capabilities in exactly one place.
 */

/**
 * The v2 capability groups that can be enabled by GATEWAY_V2_FEATURES.
 *
 * Each entry names the flag that unlocks it and the capabilities it publishes.
 * `healthz` is always on (the probe needs no flag); everything else is opt-in.
 */
export const V2_CAPABILITY_CATALOG: ReadonlyArray<{
  /** The GATEWAY_V2_FEATURES flag that enables this group. */
  feature: string
  /** Capability names published when the feature is on. */
  capabilities: readonly string[]
}> = [
  { feature: 'agent', capabilities: ['txboard.agent.whoami', 'txboard.agent.fleet.health'] },
  { feature: 'traffic', capabilities: ['txboard.traffic.settlement.logs'] },
  { feature: 'theme', capabilities: ['txboard.theme.manifest'] },
  { feature: 'knowledge', capabilities: ['txboard.knowledge.articles'] },
  { feature: 'coupons', capabilities: ['txboard.coupons.redeem'] },
  { feature: 'client-app', capabilities: ['txboard.client.app.config'] },
]

/** Capabilities that are always published, regardless of feature flags. */
export const V2_ALWAYS_CAPABILITIES: readonly string[] = [
  'txboard.health.check',
]

/**
 * Build the v2 capability list for a deployment.
 *
 * Only flags present in `enabledFeatures` (from GATEWAY_V2_FEATURES) contribute
 * capabilities; an unknown flag is ignored rather than crashing, so a
 * typo'd or future flag never breaks bootstrap. The result is deterministic
 * and deduplicated.
 */
export function v2Capabilities(enabledFeatures: readonly string[]): string[] {
  const enabled = new Set(enabledFeatures.map(f => f.trim().toLowerCase()))
  const capabilities = [...V2_ALWAYS_CAPABILITIES]
  for (const entry of V2_CAPABILITY_CATALOG) {
    if (enabled.has(entry.feature)) {
      for (const capability of entry.capabilities) capabilities.push(capability)
    }
  }
  return [...new Set(capabilities)]
}
