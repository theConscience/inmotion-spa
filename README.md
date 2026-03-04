# inmotion-spa (Этап 0)
spa with telegram bot


## 1) Подготовка
cp .env.example .env
# заполнить токены/БД

## 2) Установка и сборка
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm -w install

## 3) Запуск контейнеров
docker compose up -d --build

# Проверки
curl http://<IP>/api/health
Открыть http://<IP>/admin
