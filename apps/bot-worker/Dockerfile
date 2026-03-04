ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=10.18.3

FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN npm i -g pnpm@${PNPM_VERSION}

COPY .npmrc ./.npmrc

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot-worker/package.json ./apps/bot-worker/package.json
COPY apps/bot-api/package.json ./apps/bot-api/package.json

RUN pnpm -w install --frozen-lockfile --prod=false

FROM node:${NODE_VERSION} AS build
WORKDIR /repo
RUN npm i -g pnpm@${PNPM_VERSION}
COPY .npmrc ./.npmrc

COPY --from=deps /repo/ ./

COPY apps/bot-worker/tsconfig.json ./apps/bot-worker/tsconfig.json
COPY apps/bot-worker/src ./apps/bot-worker/src

RUN pnpm -C apps/bot-worker exec -- tsc -v
RUN pnpm --filter inmotion-worker run build

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm i -g pnpm@${PNPM_VERSION}
COPY .npmrc ./.npmrc

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot-worker/package.json ./apps/bot-worker/package.json
COPY apps/bot-api/package.json ./apps/bot-api/package.json

RUN pnpm --filter inmotion-worker install --frozen-lockfile --prod

COPY --from=build /repo/apps/bot-worker/dist ./dist

CMD ["node", "dist/worker.js"]
