FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY apps/admin/package.json pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/admin/package.json ./apps/admin/package.json
RUN pnpm -w install --frozen-lockfile


FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# важно: админка должна быть SPA build (ssr:false или build:spa)
RUN pnpm --filter admin run build:spa || pnpm --filter admin run build

# если build:spa, Nuxt кладёт статику в .output/public
# (если обычный build, тоже будет .output/public когда ssr:false)


FROM caddy:2.8-alpine AS runtime
WORKDIR /srv
COPY --from=build /repo/apps/admin/.output/public /srv

# минимальный file-server на 4000
EXPOSE 4000
CMD ["caddy","file-server","--root","/srv","--listen",":4000"]
