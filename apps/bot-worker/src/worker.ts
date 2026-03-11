import TelegramBot from "node-telegram-bot-api";
import { getToken, getUserSubscriptions } from "./moyklass.js";
import { InMemoryDedupe, dailyKey } from "./dedupe.js";
import { pickCandidates, hasFreshReplacement } from "./rules.js";
import { getUserInfo } from "./moyklass-users.js";
import {
	dbPing,
	upsertLinkByPhone,
	addCrmUserToChat,
	activateChat,
	activateUserId,
	deactivateChat,
	unlinkPhone,
	unlinkUserId,
	unlinkAllUsers,
	getLinkByChat,
	getLinkedUsersByChat,
	getActiveLinkedUsersByChat,
	getChatIdsByCrmUserId,
} from "./db.js";

/**
 * bot-worker (MVP)
 *
 * 1) Polling:
 * - берём WATCH_USER_IDS
 * - тянем абонементы /company/userSubscriptions
 * - считаем кандидатов ("скоро закончится" / "заморозка заканчивается")
 * - если нет "свежей замены" и нет дедупа -> шлём уведомление в TG
 *
 * 2) Привязка TG ↔ MoyKlass:
 * - по телефону: пользователь отправляет контакт -> ищем users?phone -> привязываем найденного клиента
 * - по userId: пользователь вручную добавляет userId
 *
 * 3) Модель связей:
 * - один chat_id -> много crm_user_id
 * - отключение уведомлений можно делать:
 *   a) для всего чата
 *   b) для одного crm_user_id
 */


/* -------------------- env -------------------- */

const USE_DB_LINKS = String(process.env.USE_DB_LINKS || "true") === "true";
const USE_ENV_CHAT_MAP = String(process.env.USE_ENV_CHAT_MAP || "false") === "true";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
if (!TG_BOT_TOKEN) {
	console.error("TG_BOT_TOKEN is empty");
	process.exit(1);
}

const MOYKLASS_API_KEY = process.env.MOYKLASS_API_KEY || "";
if (!MOYKLASS_API_KEY) {
	console.error("MOYKLASS_API_KEY is empty");
	process.exit(1);
}

const WATCH_USER_IDS = parseIntList(process.env.WATCH_USER_IDS);
const CRM_USER_TO_CHAT = parseMapUserToChat(process.env.CRM_USER_TO_CHAT);

const POLL_INTERVAL_SEC = envNum("POLL_INTERVAL_SEC", 30);

const THR = {
	daysToEnd: envNum("DAYS_TO_END", 7),
	remainVisits: envNum("REMAIN_VISITS", 2),
	freezeEndDays: envNum("FREEZE_END_DAYS", 3),
};

const MVP_DENY_USER_IDS = new Set(parseIntList(process.env.MVP_DENY_USER_IDS));

const dedupe = new InMemoryDedupe(24 * 60 * 60 * 1000);
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

let tokenCache:
	| {
		accessToken: string;
		expiresAtMs: number;
	}
	| null = null;


/* -------------------- token cache -------------------- */

async function getCachedAccessToken(): Promise<string> {
	const now = Date.now();

	if (tokenCache && now < tokenCache.expiresAtMs - 30_000) {
		return tokenCache.accessToken;
	}

	const t = await getToken(MOYKLASS_API_KEY);

	let expiresAtMs = now + 60 * 60 * 1000;
	if (t.expiresAt) {
		const parsed = Date.parse(t.expiresAt);
		if (Number.isFinite(parsed)) {
			expiresAtMs = parsed;
		}
	}

	tokenCache = {
		accessToken: t.accessToken,
		expiresAtMs,
	};

	return t.accessToken;
}


/* -------------------- helpers -------------------- */

function parseIntList(s?: string): number[] {
	if (!s) return [];

	return s
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)
		.map((x) => Number(x))
		.filter((n) => Number.isFinite(n));
}

function parseMapUserToChat(s?: string): Map<number, number> {
	const m = new Map<number, number>();
	if (!s) return m;

	for (const pair of s.split(",")) {
		const p = pair.trim();
		if (!p) continue;

		const [a, b] = p.split(":").map((x) => x.trim());
		const userId = Number(a);
		const chatId = Number(b);

		if (Number.isFinite(userId) && Number.isFinite(chatId)) {
			m.set(userId, chatId);
		}
	}

	return m;
}

function envNum(k: string, def: number): number {
	const v = Number(process.env[k]);
	return Number.isFinite(v) ? v : def;
}

function normalizePhone(input: string): string {
	const digits = input.replace(/\D/g, "");
	if (!digits) return "";
	if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
	if (digits.length === 10) return `7${digits}`;
	return digits;
}

function getStatusLabel(statusId: number): string {
	if (statusId === 2) return "Активен";
	if (statusId === 3) return "Заморожен";
	if (statusId === 4) return "Окончен";
	return "Не активен";
}

function buildNotifyKeyboard(userId: number, userSubId: number) {
	const base = `${userId}:${userSubId}`;

	return {
		inline_keyboard: [
			[
				{ text: "💳 Продлить", callback_data: `renew:${base}` },
				{ text: "✍️ Связаться", callback_data: `contact:${base}` },
			],
			[
				{ text: "🚫 Не беспокоить", callback_data: `mute_user:${base}` },
			],
		],
	};
}

function buildMainMenu() {
	return {
		reply_markup: {
			inline_keyboard: [
				[
					{ text: "📱 Привязать телефон", callback_data: "menu:link_phone" },
					{ text: "🆔 Привязать userId", callback_data: "menu:link_userid" },
				],
				[
					{ text: "👤 Моя привязка", callback_data: "menu:me" },
					{ text: "📊 Статус", callback_data: "menu:status" },
				],
				[
					{ text: "🧩 Управлять привязками", callback_data: "menu:manage_links" },
				],
				[
					{ text: "🔔 Включить всё", callback_data: "menu:enable_all" },
					{ text: "🔕 Выключить всё", callback_data: "menu:dnd" },
				],
				[
					{ text: "❌ Очистить всё", callback_data: "menu:unlink" },
				],
			],
		},
	};
}

async function sendMenu(chatId: number) {
	await bot.sendMessage(chatId, "Меню:", buildMainMenu());
}

function renderNotifyMessage(payload: {
	event: string;
	userId: number;
	userName?: string;
	remainingVisits: number;
	daysToEnd: number | null;
	freezeDaysLeft: number | null;
	endDateEffective: string | null;
	statusId?: number;
}): string {
	const name = payload.userName ? payload.userName.trim() : `Клиент ${payload.userId}`;
	const status = payload.statusId ? getStatusLabel(payload.statusId) : "—";

	if (payload.event === "subscription.frozenEnding") {
		return (
			`🧊 ${name}\n` +
			`Статус: ${status}\n\n` +
			`Заморозка скоро закончится: осталось ${payload.freezeDaysLeft ?? "—"} дн.\n` +
			`После окончания можно вернуться к тренировкам.\n\n` +
			`Нажми кнопку ниже, чтобы продлить/связаться.`
		);
	}

	const endLine = payload.endDateEffective ? `Дата окончания: ${payload.endDateEffective}\n` : "";
	const daysLine = payload.daysToEnd !== null ? `Дней до конца: ${payload.daysToEnd}\n` : "";

	return (
		`⏳ ${name}\n` +
		`Статус: ${status}\n\n` +
		`Осталось посещений: ${payload.remainingVisits}\n` +
		daysLine +
		endLine +
		`\nНажми кнопку ниже, чтобы продлить/связаться.`
	);
}


/* -------------------- db-backed routing -------------------- */

/**
 * Возвращает все chat_id для CRM user_id:
 * - сначала Postgres
 * - потом fallback из env, если явно включён
 */
async function resolveChatIdsForUser(userId: number): Promise<number[]> {
	if (USE_DB_LINKS) {
		const fromDb = await getChatIdsByCrmUserId(userId);
		if (fromDb.length) return fromDb;
	}

	if (USE_ENV_CHAT_MAP) {
		const fallback = CRM_USER_TO_CHAT.get(userId);
		return fallback ? [fallback] : [];
	}

	return [];
}


/* -------------------- telegram ui -------------------- */

const chatState = new Map<number, { mode: "await_link_user_id" }>();

async function renderMe(chatId: number) {
	const link = await getLinkByChat(chatId);
	const users = await getLinkedUsersByChat(chatId);

	if (!link) {
		await bot.sendMessage(chatId, "Привязки нет.");
		return;
	}

	let userLines: string[] = [];

	if (users.length) {
		try {
			const token = await getCachedAccessToken();

			for (const u of users) {
				let label = `${u.crmUserId}`;
				try {
					const info = await getUserInfo(token, u.crmUserId);
					if (info?.name) {
						label = `${info.name} (${u.crmUserId})`;
					}
				} catch {
					// fallback: оставим только id
				}

				userLines.push(`• ${label} — ${u.isActive ? "active" : "off"}`);
			}
		} catch {
			userLines = users.map((u) => `• ${u.crmUserId} — ${u.isActive ? "active" : "off"}`);
		}
	} else {
		userLines = ["• userId привязок нет"];
	}

	await bot.sendMessage(
		chatId,
		[
			"Твоя привязка:",
			`chat_id: ${link.chatId}`,
			`phone: ${link.phone ?? "—"}`,
			`active: ${link.isActive}`,
			"",
			"CRM users:",
			...userLines,
		].join("\n"),
	);
}

async function renderStatus(chatId: number) {
	const link = await getLinkByChat(chatId);

	if (!link?.isActive) {
		await bot.sendMessage(chatId, "Чат отключён. Сначала снова активируй привязку.");
		return;
	}

	const userIds = await getActiveLinkedUsersByChat(chatId);
	if (!userIds.length) {
		await bot.sendMessage(chatId, "Нет активных привязок к userId. Сначала привяжи телефон или userId.");
		return;
	}

	const token = await getCachedAccessToken();
	const chunks: string[] = [];

	for (const crmUserId of userIds) {
		let title = String(crmUserId);

		try {
			const info = await getUserInfo(token, crmUserId);
			if (info?.name) {
				title = `${info.name} (${crmUserId})`;
			}
		} catch {}

		const subs = await getUserSubscriptions(token, crmUserId);
		const candidates = pickCandidates(subs, crmUserId, THR, new Date());

		if (!candidates.length) {
			chunks.push(`• ${title}: сейчас нет событий`);
			continue;
		}

		chunks.push(`• ${title}:`);
		for (const c of candidates.slice(0, 3)) {
			const st = subs.find((x) => x.id === c.userSubscriptionId)?.statusId ?? 0;
			chunks.push(
				`  - ${c.event} | subId ${c.userSubscriptionId} | статус ${getStatusLabel(st)} | остаток ${c.remainingVisits} | дней ${c.daysToEnd ?? "—"}`
			);
		}
	}

	await bot.sendMessage(chatId, `Статус по привязанным userId:\n\n${chunks.join("\n")}`);
}

async function renderManageLinks(chatId: number) {
	const users = await getLinkedUsersByChat(chatId);

	if (!users.length) {
		await bot.sendMessage(chatId, "Нет привязанных userId.");
		await sendMenu(chatId);
		return;
	}

	const rows: Array<Array<{ text: string; callback_data: string }>> = [];

	for (const u of users) {
		rows.push([
			{
				text: `${u.isActive ? "🔕 Выкл" : "🔔 Вкл"} ${u.crmUserId}`,
				callback_data: u.isActive
					? `disable_user:${u.crmUserId}`
					: `enable_user:${u.crmUserId}`,
			},
			{
				text: `❌ ${u.crmUserId}`,
				callback_data: `unlink_user:${u.crmUserId}`,
			},
		]);
	}

	rows.push([{ text: "⬅️ Назад в меню", callback_data: "menu:back" }]);

	await bot.sendMessage(chatId, "Управление привязками:", {
		reply_markup: {
			inline_keyboard: rows,
		},
	});
}

bot.on("callback_query", async (q) => {
	const chatId = q.message?.chat?.id;
	const data = q.data || "";
	if (!chatId) return;

	try {
		await bot.answerCallbackQuery(q.id);
	} catch {}

	if (data === "menu:link_phone") {
		await bot.sendMessage(chatId, "Нажми кнопку ниже и отправь контакт:", {
			reply_markup: {
				keyboard: [[{ text: "📱 Отправить контакт", request_contact: true }]],
				resize_keyboard: true,
				one_time_keyboard: true,
			},
		});
		return;
	}

	if (data === "menu:link_userid") {
		chatState.set(chatId, { mode: "await_link_user_id" });
		await bot.sendMessage(chatId, "Введи userId из МойКласс (только цифры). Например: 5170959");
		return;
	}

	if (data === "menu:me") {
		await renderMe(chatId);
		return;
	}

	if (data === "menu:status") {
		try {
			await dbPing();
		} catch (e) {
			await bot.sendMessage(chatId, `DB недоступна: ${String(e)}`);
			return;
		}

		try {
			await renderStatus(chatId);
		} catch (e) {
			await bot.sendMessage(chatId, `Ошибка MoyKlass: ${String(e)}`);
		}
		return;
	}

	if (data === "menu:manage_links") {
		await renderManageLinks(chatId);
		return;
	}

	if (data === "menu:enable_all") {
		await activateChat(chatId);

		const users = await getLinkedUsersByChat(chatId);
		for (const u of users) {
			await activateUserId(chatId, u.crmUserId);
		}

		await bot.sendMessage(chatId, "🔔 Уведомления снова включены.");
		await sendMenu(chatId);
		return;
	}

	if (data === "menu:back") {
		await sendMenu(chatId);
		return;
	}

	if (data === "menu:dnd") {
		await deactivateChat(chatId);
		await bot.sendMessage(chatId, "🚫 Ок. Уведомления для всего чата отключены.");
		return;
	}

	if (data === "menu:unlink") {
		await deactivateChat(chatId);
		await unlinkPhone(chatId);
		await unlinkAllUsers(chatId);
		await bot.sendMessage(chatId, "❌ Телефон и все userId отвязаны.");
		return;
	}

	if (data.startsWith("disable_user:")) {
		const crmUserId = Number(data.split(":")[1]);

		if (Number.isFinite(crmUserId)) {
			await unlinkUserId(chatId, crmUserId);
			await bot.sendMessage(chatId, `🔕 userId ${crmUserId} отключён.`);
			await renderManageLinks(chatId);
		}
		return;
	}

	if (data.startsWith("enable_user:")) {
		const crmUserId = Number(data.split(":")[1]);

		if (Number.isFinite(crmUserId)) {
			await activateChat(chatId);
			await activateUserId(chatId, crmUserId);
			await bot.sendMessage(chatId, `🔔 userId ${crmUserId} снова включён.`);
			await renderManageLinks(chatId);
		}
		return;
	}

	if (data.startsWith("unlink_user:")) {
		const crmUserId = Number(data.split(":")[1]);

		if (Number.isFinite(crmUserId)) {
			await unlinkUserId(chatId, crmUserId);
			await bot.sendMessage(chatId, `❌ userId ${crmUserId} отвязан.`);
			await renderManageLinks(chatId);
		}
		return;
	}

	if (data.startsWith("mute_user:")) {
		const [, userIdRaw] = data.split(":");
		const crmUserId = Number(userIdRaw);

		if (Number.isFinite(crmUserId)) {
			await unlinkUserId(chatId, crmUserId);
			await bot.sendMessage(chatId, `🚫 Ок. Отключил уведомления для userId ${crmUserId}.`);
		}
		return;
	}

	if (data.startsWith("renew:")) {
		await bot.sendMessage(chatId, "💳 Ок. Для продления: напиши администратору (MVP).");
		return;
	}

	if (data.startsWith("contact:")) {
		await bot.sendMessage(chatId, "✍️ Ок. Администратор свяжется с тобой (MVP).");
		return;
	}
});

bot.on("message", async (msg) => {
	const chatId = msg.chat?.id;
	if (!chatId) return;

	const text = (msg.text || "").trim();

	if (text.startsWith("/start")) {
		chatState.delete(chatId);
		await bot.sendMessage(chatId, "Привет! Я бот InMotion. Вот меню 👇");
		await sendMenu(chatId);
		return;
	}

	if (text.startsWith("/menu")) {
		chatState.delete(chatId);
		await sendMenu(chatId);
		return;
	}

	if (text.startsWith("/me")) {
		await renderMe(chatId);
		return;
	}

	if (text.startsWith("/status")) {
		try {
			await dbPing();
		} catch (e) {
			await bot.sendMessage(chatId, `DB недоступна: ${String(e)}`);
			return;
		}

		try {
			await renderStatus(chatId);
		} catch (e) {
			await bot.sendMessage(chatId, `Ошибка MoyKlass: ${String(e)}`);
		}
		return;
	}

	if (text.startsWith("/unlink_phone")) {
		await unlinkPhone(chatId);
		await bot.sendMessage(chatId, "Ок. Телефон отвязан.");
		await sendMenu(chatId);
		return;
	}

	if (text.startsWith("/unlink_all")) {
		await unlinkAllUsers(chatId);
		await bot.sendMessage(chatId, "Ок. Все userId отвязаны.");
		await sendMenu(chatId);
		return;
	}

	if (text.startsWith("/unlink_userid")) {
		const m = text.match(/^\/unlink_userid\s+(\d+)$/);
		if (!m) {
			await bot.sendMessage(chatId, "Формат: /unlink_userid 5170959");
			return;
		}

		const crmUserId = Number(m[1]);
		await unlinkUserId(chatId, crmUserId);
		await bot.sendMessage(chatId, `Ок. userId ${crmUserId} отвязан.`);
		await sendMenu(chatId);
		return;
	}

	if (text.startsWith("/unlink")) {
		await deactivateChat(chatId);
		await bot.sendMessage(chatId, "Ок. Канал отключён (is_active=false).");
		return;
	}

	// Contact flow: TG contact -> phone -> MoyKlass users?phone -> link
	if (msg.contact?.phone_number) {
		const phone = normalizePhone(msg.contact.phone_number);

		await upsertLinkByPhone(chatId, phone);
		console.log("tg contact received", { chatId, phone });

		try {
			const token = await getCachedAccessToken();
			const users = await findMoyklassUsersByPhone(token, phone);

      const hasNoUser = users.length === 0
      const hasSingleUser = users.length === 1

			if (hasNoUser) {
				await bot.sendMessage(chatId, `Не нашёл клиента в МойКласс по номеру ${phone}.`);
        await bot.sendMessage(chatId, "Главное меню возвращено 👇", {
          reply_markup: { remove_keyboard: true },
        });
				await sendMenu(chatId);

				return;
			}

			if (hasSingleUser) {
				const u = users[0];
				await addCrmUserToChat(chatId, u.id);
				await bot.sendMessage(chatId, `✅ Привязал.\nМойКласс: ${u.name ?? "без имени"} (id ${u.id})\nТелефон: ${phone}`);
        await bot.sendMessage(chatId, "Главное меню возвращено 👇", {
          reply_markup: { remove_keyboard: true },
        });
				await sendMenu(chatId);

				return;
			}

			const lines = users
				.slice(0, 10)
				.map((u) => `• id ${u.id} — ${u.name ?? "без имени"}`)
				.join("\n");

			await bot.sendMessage(
				chatId,
				`Нашёл несколько клиентов по номеру ${phone}:\n${lines}\n\nНажми “🆔 Привязать userId” и введи нужный id.`
			);
      await bot.sendMessage(chatId, "Главное меню возвращено 👇", {
        reply_markup: { remove_keyboard: true },
      });
			await sendMenu(chatId);
		} catch (e) {
			await bot.sendMessage(chatId, `Ошибка при поиске в МойКласс: ${String(e)}`);
      await bot.sendMessage(chatId, "Главное меню возвращено 👇", {
        reply_markup: { remove_keyboard: true },
      });
			await sendMenu(chatId);
		}

		return;
	}

	// Await userId typed by user
	const st = chatState.get(chatId);
	if (st?.mode === "await_link_user_id") {
		const id = Number(text);
		if (!Number.isFinite(id) || id <= 0) {
			await bot.sendMessage(chatId, "Не похоже на userId. Введи только цифры.");

			return;
		}

		await addCrmUserToChat(chatId, id);
		chatState.delete(chatId);
		await bot.sendMessage(chatId, `✅ Привязал userId ${id}. Напиши /status чтобы проверить.`);
    await bot.sendMessage(chatId, "Главное меню возвращено 👇", {
      reply_markup: { remove_keyboard: true },
    });
		await sendMenu(chatId);

		return;
	}
});


/* -------------------- crm helpers -------------------- */

async function findMoyklassUsersByPhone(token: string, phone: string): Promise<Array<{ id: number; name?: string }>> {
	const qs = new URLSearchParams();
	qs.set("phone", phone);
	qs.set("limit", "10");

	const r = await fetch(`https://api.moyklass.com/v1/company/users?${qs.toString()}`, {
		headers: { "x-access-token": token, "Content-Type": "application/json" },
	});

	if (!r.ok) {
		const t = await r.text().catch(() => "");
		throw new Error(`moyklass users?phone failed: ${r.status} ${t}`);
	}

	const j = (await r.json()) as {
		users?: Array<{ id: number; name?: string }>
	};

	return j.users ?? [];
}


/* -------------------- polling -------------------- */

async function pollOnce() {
	const token = await getCachedAccessToken();

	for (const userId of WATCH_USER_IDS) {
		if (MVP_DENY_USER_IDS.has(userId)) {
			continue;
		}

		const chatIds = await resolveChatIdsForUser(userId);
		if (!chatIds.length) {
			continue;
		}

		const subs = await getUserSubscriptions(token, userId);
		const candidates = pickCandidates(subs, userId, THR, new Date());

		if (!candidates.length) {
			continue;
		}

		for (const ev of candidates) {
			if (hasFreshReplacement(subs, ev, THR, new Date())) {
				continue;
			}

			const key = dailyKey({
				userId,
				userSubId: ev.userSubscriptionId,
				event: ev.event,
			});

			if (dedupe.seen(key)) {
				continue;
			}

			let userName: string | undefined;
			try {
				const user = await getUserInfo(token, userId);
				userName = user?.name;
			} catch {}

			const statusId = subs.find((x) => x.id === ev.userSubscriptionId)?.statusId;

			const msg = renderNotifyMessage({
				event: ev.event,
				userId,
				userName,
				remainingVisits: ev.remainingVisits,
				daysToEnd: ev.daysToEnd,
				freezeDaysLeft: ev.freezeDaysLeft,
				endDateEffective: ev.endDateEffective,
				statusId,
			});

			for (const chatId of chatIds) {
				await bot.sendMessage(chatId, msg, {
					reply_markup: buildNotifyKeyboard(userId, ev.userSubscriptionId),
				});

				console.log("sent", {
					userId,
					chatId,
					event: ev.event,
					userSubId: ev.userSubscriptionId,
				});
			}

			dedupe.remember(key);
		}
	}
}


/* -------------------- boot -------------------- */

console.log("Worker polling started");
console.log("MVP poll config", { WATCH_USER_IDS, POLL_INTERVAL_SEC, THR });

(async () => {
	try {
		await dbPing();
	} catch (e) {
		console.error("dbPing failed", String(e));
	}

	await pollOnce();

	setInterval(async () => {
		try {
			await pollOnce();
		} catch (e) {
			console.error("pollOnce failed", String(e));
		}
	}, POLL_INTERVAL_SEC * 1000);
})().catch((e) => {
	console.error("worker init failed", String(e));
	process.exit(1);
});
