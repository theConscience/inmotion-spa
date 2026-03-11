import { Pool } from "pg";

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
	isActive: boolean;
};

export type TgLinkedUser = {
	chatId: number;
	crmUserId: number;
	isActive: boolean;
};

export async function dbPing() {
	console.warn("pinging DB...");
	await pool.query("select 1");
}

export async function upsertLinkByPhone(chatId: number, phone: string) {
	console.warn("rewrite link by phone:", phone, " for chat with #id:", chatId);

	await pool.query(
		`
		insert into tg_links(chat_id, phone, is_active, updated_at)
		values ($1, $2, true, now())
		on conflict (chat_id)
		do update set
			phone = excluded.phone,
			is_active = true,
			updated_at = now()
		`,
		[chatId, phone],
	);
}

export async function ensureChatLink(chatId: number) {
	await pool.query(
		`
		insert into tg_links(chat_id, is_active, updated_at)
		values ($1, true, now())
		on conflict (chat_id)
		do update set
			is_active = true,
			updated_at = now()
		`,
		[chatId],
	);
}

export async function addCrmUserToChat(chatId: number, crmUserId: number) {
	console.warn("attach CRM user_id:", crmUserId, " to chat:", chatId);

	await ensureChatLink(chatId);

	await pool.query(
		`
		insert into tg_link_users(chat_id, crm_user_id, is_active, updated_at)
		values ($1, $2, true, now())
		on conflict (chat_id, crm_user_id)
		do update set
			is_active = true,
			updated_at = now()
		`,
		[chatId, crmUserId],
	);
}

export async function deactivateChat(chatId: number) {
	console.warn("deactivating chat with #id:", chatId);

	await pool.query(
		`
		update tg_links
		   set is_active = false, updated_at = now()
		 where chat_id = $1
		`,
		[chatId],
	);

	await pool.query(
		`
		update tg_link_users
		   set is_active = false, updated_at = now()
		 where chat_id = $1
		`,
		[chatId],
	);
}

export async function unlinkPhone(chatId: number) {
	console.warn("unlinking phone from chat with #id:", chatId);

	await pool.query(
		`
		update tg_links
		   set phone = null, updated_at = now()
		 where chat_id = $1
		`,
		[chatId],
	);
}

export async function unlinkUserId(chatId: number, crmUserId: number) {
	console.warn("unlinking CRM user_Id:", crmUserId, " from chat with #id:", chatId);

	await pool.query(
		`
		update tg_link_users
		   set is_active = false, updated_at = now()
		 where chat_id = $1
		   and crm_user_id = $2
		`,
		[chatId, crmUserId],
	);
}

export async function unlinkAllUsers(chatId: number) {
	console.warn("unlinking all CRM user_ids from chat with #id:", chatId);

	await pool.query(
		`
		update tg_link_users
		   set is_active = false, updated_at = now()
		 where chat_id = $1
		`,
		[chatId],
	);
}

export async function getLinkByChat(chatId: number): Promise<TgLink | null> {
	console.warn("receiving info by chat_id:", chatId);

	const r = await pool.query(
		`
		select chat_id, phone, is_active
		  from tg_links
		 where chat_id = $1
		 limit 1
		`,
		[chatId],
	);

	if (!r.rowCount) return null;

	const row = r.rows[0];
	return {
		chatId: Number(row.chat_id),
		phone: row.phone ?? null,
		isActive: Boolean(row.is_active),
	};
}

export async function getLinkedUsersByChat(chatId: number): Promise<TgLinkedUser[]> {
	const r = await pool.query(
		`
		select chat_id, crm_user_id, is_active
		  from tg_link_users
		 where chat_id = $1
		 order by crm_user_id asc
		`,
		[chatId],
	);

	return r.rows.map((row) => ({
		chatId: Number(row.chat_id),
		crmUserId: Number(row.crm_user_id),
		isActive: Boolean(row.is_active),
	}));
}

export async function getActiveLinkedUsersByChat(chatId: number): Promise<number[]> {
	const r = await pool.query(
		`
		select crm_user_id
		  from tg_link_users
		 where chat_id = $1
		   and is_active = true
		 order by crm_user_id asc
		`,
		[chatId],
	);

	return r.rows.map((row) => Number(row.crm_user_id));
}

export async function getChatIdsByCrmUserId(crmUserId: number): Promise<number[]> {
	console.warn("receiving chat_ids by CRM user_id", crmUserId);

	const r = await pool.query(
		`
		select u.chat_id
		  from tg_link_users u
		  join tg_links l on l.chat_id = u.chat_id
		 where u.crm_user_id = $1
		   and u.is_active = true
		   and l.is_active = true
		 order by u.chat_id asc
		`,
		[crmUserId],
	);

	return r.rows.map((row) => Number(row.chat_id));
}

export async function activateChat(chatId: number) {
	await pool.query(
		`
		update tg_links
		   set is_active = true, updated_at = now()
		 where chat_id = $1
		`,
		[chatId],
	);
}

export async function activateUserId(chatId: number, crmUserId: number) {
	await ensureChatLink(chatId);

	await pool.query(
		`
		insert into tg_link_users(chat_id, crm_user_id, is_active, updated_at)
		values ($1, $2, true, now())
		on conflict (chat_id, crm_user_id)
		do update set
			is_active = true,
			updated_at = now()
		`,
		[chatId, crmUserId],
	);
}

export async function closeDb() {
	console.warn("closing connection to DB...");
	await pool.end();
}
