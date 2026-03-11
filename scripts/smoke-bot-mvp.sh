#!/usr/bin/env bash
set -euo pipefail

CHAT_ID="${1:-136075826}"
MODE="${2:-show}" # show | deactivate

echo "== worker recreate =="
docker compose up -d --force-recreate worker

sleep 3

echo
echo "== worker logs =="
docker compose logs --tail=80 worker

echo
echo "== tg_links =="
docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
SELECT *
FROM tg_links
WHERE chat_id = ${CHAT_ID};
"

echo
echo "== tg_link_users =="
docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
SELECT *
FROM tg_link_users
WHERE chat_id = ${CHAT_ID}
ORDER BY crm_user_id;
"

if [[ "${MODE}" == "deactivate" ]]; then
	echo
	echo "== deactivate whole chat =="
	docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
	UPDATE tg_links
	SET is_active = false
	WHERE chat_id = ${CHAT_ID};

	UPDATE tg_link_users
	SET is_active = false
	WHERE chat_id = ${CHAT_ID};
	"

	echo
	echo "== state after deactivate =="
	docker compose exec -T db psql -U "inmotion" -d "inmotion" -c "
	SELECT *
	FROM tg_links
	WHERE chat_id = ${CHAT_ID};

	SELECT *
	FROM tg_link_users
	WHERE chat_id = ${CHAT_ID}
	ORDER BY crm_user_id;
	"
fi

echo
echo "== manual Telegram checks =="
echo "1. /start"
echo "2. menu buttons"
echo "3. /me"
echo "4. contact link"
echo "5. /link_userid 5170959"
echo "6. /link_userid 5402940"
echo "7. /status"
echo "8. mute one user from notification button"
