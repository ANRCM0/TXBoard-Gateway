FROM node:22.23.2-alpine AS builder
WORKDIR /srv
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/theme-sdk/package.json packages/theme-sdk/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/gateway/tsconfig.json apps/gateway/tsconfig.json
COPY apps/gateway/src apps/gateway/src
RUN npm run build --workspace @txboard/gateway
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.2-alpine
WORKDIR /srv
ENV NODE_ENV=production
ENV GATEWAY_HOST=0.0.0.0
USER node
COPY --chown=node:node --from=builder /srv/node_modules ./node_modules
COPY --chown=node:node --from=builder /srv/apps/gateway/dist ./apps/gateway/dist
EXPOSE 8787
CMD ["node", "apps/gateway/dist/index.js"]
