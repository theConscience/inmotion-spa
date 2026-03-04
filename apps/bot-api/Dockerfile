# ---------- deps (устанавливаем зависимости с pnpm) ----------
FROM node:22-alpine AS deps
WORKDIR /app
# включаем pnpm через corepack
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# копим только пакетный манифест и лок — детерминированная сборка
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- build (собираем TypeScript -> dist) ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# re-use deps
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---------- runtime (чистый прод-образ) ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# ставим только prod-зависимости (минимальный образ)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
# кладём собранный код
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node","dist/server.js"]
