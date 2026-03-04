# README.md
#
# CHANGED: убрали corepack prepare, потому что сборка теперь ставит pnpm внутри Dockerfile.
# CHANGED: чётко разделили “локально без Docker” и “в Docker”.

# inmotion-spa (Этап 0)
spa with telegram bot

## 1) Подготовка
cp .env.example .env
# заполнить токены/БД

## 2) Запуск через Docker (рекомендуется)
docker compose up -d --build

# Проверки
curl http://<IP>/health
curl http://<IP>/api/health
Открыть http://<IP>/admin/

## 3) Локальная разработка без Docker (опционально)
# Нужен pnpm (на Mac):
# corepack enable
# corepack prepare pnpm@9.12.0 --activate
# pnpm -w install
# pnpm dev
