FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/desk/package.json ./apps/desk/
COPY apps/external-agent/package.json ./apps/external-agent/

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && npm ci \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/* /root/.npm

COPY packages ./packages
COPY apps ./apps

RUN npm run build \
  && mkdir -p /app/data /app/keys

EXPOSE 8787 5173

CMD ["npm", "run", "start", "-w", "@tta/gateway"]
