import { Pool } from "pg";

/**
 * db.ts (bot-worker)
 * Храним привязку Telegram chat_id ↔ (phone, crm_user_id) в Postgres.
 *
 * Это MVP-уровень:
 * - одна таблица tg_links
 * - операции upsert / deactivate / lookup
 */

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

export type TgLink = {
  chatId: number;
  phone: string | null;
  crmUserId: number | null;
  isActive: boolean;
};

export async function dbPing() {
  await pool.query("select 1");
}

export async function upsertLinkByPhone(chatId: number, phone: string) {
  await pool.query(
    `
    insert into tg_links(chat_id, phone, crm_user_id, is_active, updated_at)
    values ($1, $2, null, true, now())
    on conflict (chat_id)
    do update set phone = excluded.phone, is_active = true, updated_at = now()
    `,
    [chatId, phone]
  );
}

export async function upsertLinkByUserId(chatId: number, crmUserId: number) {
  // Если crm_user_id уже привязан к другому чату — перетираем (для демо удобно).
  // В проде можно сделать подтверждение/разруливание.
  await pool.query(
    `
    update tg_links
       set is_active = false, updated_at = now()
     where crm_user_id = $1
       and chat_id <> $2
       and is_active = true
    `,
    [crmUserId, chatId]
  );

  await pool.query(
    `
    insert into tg_links(chat_id, phone, crm_user_id, is_active, updated_at)
    values ($1, null, $2, true, now())
    on conflict (chat_id)
    do update set crm_user_id = excluded.crm_user_id, is_active = true, updated_at = now()
    `,
    [chatId, crmUserId]
  );
}

export async function setCrmUserIdForChat(chatId: number, crmUserId: number) {
  await pool.query(
    `
    update tg_links
       set crm_user_id = $2, is_active = true, updated_at = now()
     where chat_id = $1
    `,
    [chatId, crmUserId]
  );
}

export async function deactivateChat(chatId: number) {
  await pool.query(
    `
    update tg_links
       set is_active = false, updated_at = now()
     where chat_id = $1
    `,
    [chatId]
  );
}

export async function unlinkPhone(chatId: number) {
  await pool.query(
    `
    update tg_links
       set phone = null, updated_at = now()
     where chat_id = $1
    `,
    [chatId]
  );
}

export async function unlinkUserId(chatId: number) {
  await pool.query(
    `
    update tg_links
       set crm_user_id = null, updated_at = now()
     where chat_id = $1
    `,
    [chatId]
  );
}

export async function getLinkByChat(chatId: number): Promise<TgLink | null> {
  const r = await pool.query(
    `
    select chat_id, phone, crm_user_id, is_active
      from tg_links
     where chat_id = $1
     limit 1
    `,
    [chatId]
  );

  if (!r.rowCount) return null;

  const row = r.rows[0];
  return {
    chatId: Number(row.chat_id),
    phone: row.phone ?? null,
    crmUserId: row.crm_user_id !== null ? Number(row.crm_user_id) : null,
    isActive: Boolean(row.is_active),
  };
}

export async function getChatIdByCrmUserId(crmUserId: number): Promise<number | null> {
  const r = await pool.query(
    `
    select chat_id
      from tg_links
     where crm_user_id = $1
       and is_active = true
     limit 1
    `,
    [crmUserId]
  );

  if (!r.rowCount) return null;
  return Number(r.rows[0].chat_id);
}

export async function closeDb() {
  await pool.end();
}
