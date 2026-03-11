#!/usr/bin/env bash
set -euo pipefail

CHAT_ID="${1:-136075826}"

echo "== recreate worker =="
docker compose up -d --force-recreate worker

echo
echo "== worker logs =="
sleep 3
docker compose logs --tail=80 worker

echo
echo "== tg_links row =="
docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
SELECT *
FROM tg_links
WHERE chat_id = ${CHAT_ID};
"

echo
echo "== manual checks in Telegram =="
echo "1. /start"
echo "2. click menu buttons"
echo "3. /me"
echo "4. send contact"
echo "5. /status"
echo "6. click DND"
echo "7. verify no more sends for this chat in worker logs"


# echo "== Show tg_links before =="
# docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
# SELECT *
# FROM tg_links
# WHERE chat_id = ${CHAT_ID};
# "

# echo
# echo "== Deactivate this chat =="
# docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
# UPDATE tg_links
# SET is_active = FALSE
# WHERE chat_id = ${CHAT_ID};
# "

# echo
# echo "== Show tg_links after =="
# docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
# SELECT *
# FROM tg_links
# WHERE chat_id = ${CHAT_ID};
# "

# echo
# echo "== Restart worker =="
# docker compose up -d --force-recreate worker
# sleep 3

# echo
# echo "== Worker logs =="
# docker compose logs --tail=80 worker

# echo
# echo "Check manually that no new TG messages arrive for chat_id=${CHAT_ID}"
