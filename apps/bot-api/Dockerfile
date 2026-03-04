ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=10.18.3

FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN npm i -g pnpm@${PNPM_VERSION}

# одинаковая конфигурация npm внутри контенейра
COPY .npmrc ./.npmrc

# root manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ВАЖНО: package.json каждого workspace — по СВОЕМУ пути
COPY apps/bot-api/package.json ./apps/bot-api/package.json
COPY apps/bot-worker/package.json ./apps/bot-worker/package.json
# если packages появятся — добавишь аналогично

# ставим devDeps тоже (нужны для tsc)
RUN pnpm -w install --frozen-lockfile --prod=false

FROM node:${NODE_VERSION} AS build
WORKDIR /repo
RUN npm i -g pnpm@${PNPM_VERSION}
COPY .npmrc ./.npmrc

COPY --from=deps /repo/ ./

# исходники API
COPY apps/bot-api/tsconfig.json ./apps/bot-api/tsconfig.json
COPY apps/bot-api/src ./apps/bot-api/src

# железная проверка
RUN pnpm -C apps/bot-api exec -- tsc -v
RUN pnpm --filter inmotion-api run build

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm i -g pnpm@${PNPM_VERSION}
COPY .npmrc ./.npmrc

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot-api/package.json ./apps/bot-api/package.json
COPY apps/bot-worker/package.json ./apps/bot-worker/package.json

# только prod-зависимости
RUN pnpm --filter inmotion-api install --frozen-lockfile --prod

COPY --from=build /repo/apps/bot-api/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.js"]
