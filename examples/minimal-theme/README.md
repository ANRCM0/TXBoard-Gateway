# Minimal independent theme example

`src/main.ts` illustrates the independent theme SDK contract without committing to a specific SPA framework. It must be bundled by your theme's toolchain and executed in a browser. It does **not** grant theme permissions or imply that standalone Theme Package installation is already supported by TXBoard.

The Gateway API is opt-in and must be reachable at `/gateway/v1` on the same origin (or the site's exact origin must be allowlisted).
