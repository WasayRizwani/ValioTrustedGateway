FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/desk/package.json ./apps/desk/
COPY apps/external-agent/package.json ./apps/external-agent/

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && npm ci \
  && rm -rf /var/lib/apt/lists/* /root/.npm

COPY packages ./packages
COPY apps ./apps

RUN npm run build \
  && mkdir -p /app/data /app/keys

ENV NODE_ENV=production \
    PORT=8787 \
    GATEWAY_PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "if [ ! -f /app/data/products.json ] && [ -n \"$VALIO_API_KEY\" ]; then npm run download-data -w @tta/gateway || true; fi && exec npm run start -w @tta/gateway"]
