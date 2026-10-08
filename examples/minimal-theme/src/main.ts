import { createTXBoardClient } from '@txboard/theme-sdk'

// A React, Vue or standalone theme can use the same client.
const client = createTXBoardClient({ baseURL: '/gateway/v1' })

export async function loadPublicThemeHome() {
  const [{ site, theme }, plans] = await Promise.all([
    client.bootstrap(),
    client.plans.list(),
  ])

  // Theme-owned public appearance settings are supplied by TXBoard.
  // Only theme code decides how to render them; never use them as authority.
  return {
    title: site.name,
    selectedTheme: theme.name,
    appearance: theme.config,
    plans,
  }
}

// For authenticated screens, pass a user bearer via getToken.
// Prefer a server-backed session architecture when available;
// never put admin tokens or fixed encryption secrets in a theme bundle.
