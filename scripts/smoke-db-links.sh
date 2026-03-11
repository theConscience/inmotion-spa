#!/usr/bin/env bash
set -euo pipefail

DB_SERVICE="db"
DB_NAME="${POSTGRES_DB:-inmotion}"
DB_USER="${POSTGRES_USER:-inmotion}"

echo "==> checking postgres container"
docker compose ps

echo
echo "==> checking tg_links exists"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT to_regclass('public.tg_links');"

echo
echo "==> checking tg_link_users exists"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT to_regclass('public.tg_link_users');"

echo
echo "==> applying 003 migration if mounted"
docker compose exec -T "$DB_SERVICE" sh -lc '
if [ -f /migrations/003_tg_link_users.sql ]; then
  psql -U "'"$DB_USER"'" -d "'"$DB_NAME"'" -f /migrations/003_tg_link_users.sql
else
  echo "migration file /migrations/003_tg_link_users.sql not found inside container"
  exit 1
fi
'

echo
echo "==> describe tg_link_users"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c '\d+ tg_link_users'

echo
echo "==> insert smoke test data"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'
insert into tg_links (chat_id, phone, is_active)
values (900001111, '79990001111', true)
on conflict (chat_id) do update
set phone = excluded.phone,
    is_active = true,
    updated_at = now();

insert into tg_link_users (chat_id, crm_user_id, is_active)
values (900001111, 5170959, true)
on conflict (chat_id, crm_user_id) do update
set is_active = true,
    updated_at = now();
SQL

echo
echo "==> verify inserted rows"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c "
select *
from tg_links
where chat_id = 900001111;
"

docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c "
select *
from tg_link_users
where chat_id = 900001111
order by crm_user_id;
"

echo
echo "==> cleanup smoke rows"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'
delete from tg_link_users where chat_id = 900001111;
delete from tg_links where chat_id = 900001111;
SQL

echo
echo "==> final check"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -c "
select *
from tg_link_users
where chat_id = 900001111;
"

echo
echo "OK: smoke test passed"
