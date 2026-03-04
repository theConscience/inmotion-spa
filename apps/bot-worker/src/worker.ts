import TelegramBot from 'node-telegram-bot-api';
import { getToken, getUserSubscriptions } from './moyklass.js';
import { InMemoryDedupe, dailyKey } from './dedupe.js';
import { pickCandidates, hasFreshReplacement } from './rules.js';
import { getUserInfo } from "./moyklass-users";

function parseIntList (s?: string)
{
	if (!s) return [];
	return s.split(',').map(x => x.trim()).filter(Boolean).map(x => Number(x)).filter(n => Number.isFinite(n));
}

function parseMapUserToChat (s?: string)
{
	const m = new Map<number, number>();
	if (!s) return m;

	for (const pair of s.split(','))
	{
		const p = pair.trim();
		if (!p) continue;

		const [a, b] = p.split(':').map(x => x.trim());
		const userId = Number(a);
		const chatId = Number(b);

		if (Number.isFinite(userId) && Number.isFinite(chatId))
		{
			m.set(userId, chatId);
		}
	}

	return m;
}

function envNum (k: string, def: number)
{
	const v = Number(process.env[k]);
	return Number.isFinite(v) ? v : def;
}

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
if (!TG_BOT_TOKEN)
{
	console.error('TG_BOT_TOKEN is empty');
	process.exit(1);
}

const MOYKLASS_API_KEY = process.env.MOYKLASS_API_KEY || '';
if (!MOYKLASS_API_KEY)
{
	console.error('MOYKLASS_API_KEY is empty');
	process.exit(1);
}

const WATCH_USER_IDS = parseIntList(process.env.WATCH_USER_IDS);
const CRM_USER_TO_CHAT = parseMapUserToChat(process.env.CRM_USER_TO_CHAT);

const POLL_INTERVAL_SEC = envNum('POLL_INTERVAL_SEC', 300);
const THR =
{
	daysToEnd: envNum('DAYS_TO_END', 5),
	remainVisits: envNum('REMAIN_VISITS', 1),
	freezeEndDays: envNum('FREEZE_END_DAYS', 3)
};

const dedupe = new InMemoryDedupe(26 * 60 * 60 * 1000); // 26h “на сутки”
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getCachedAccessToken ()
{
	const now = Date.now();

	if (cachedToken && now < cachedToken.expiresAtMs - 60_000)
	{
		return cachedToken.token;
	}

	const t = await getToken(MOYKLASS_API_KEY);

	const ttlMs =
		t.expiresAt
			? Math.max(5 * 60 * 1000, (new Date(t.expiresAt).getTime() - now))
			: (envNum('MOYKLASS_TOKEN_TTL_SEC', 7200) * 1000);

	cachedToken =
	{
		token: t.accessToken,
		expiresAtMs: now + ttlMs
	};

	return cachedToken.token;
}


function statusLabel(statusId: number) {
  if (statusId === 2) return "Активен";
  if (statusId === 3) return "Заморожен";
  if (statusId === 4) return "Окончен";
  return "Не активен";
}

function buildKeyboard(userId: number, userSubId: number) {
  // callback_data ограничено 64 байтами → коротко кодируем
  const base = `${userId}:${userSubId}`;

  return {
    inline_keyboard: [
      [
        { text: "💳 Продлить", callback_data: `renew:${base}` },
        { text: "✍️ Связаться", callback_data: `contact:${base}` },
      ],
      [{ text: "🚫 Не беспокоить", callback_data: `stop:${base}` }],
    ],
  };
}

function renderMessage(payload: {
  event: string;
  userId: number;
  userName?: string;
  remainingVisits: number;
  daysToEnd: number | null;
  freezeDaysLeft: number | null;
  endDateEffective: string | null;
  statusId?: number;
}) {
  const name = payload.userName ? payload.userName.trim() : `Клиент ${payload.userId}`;
  const status = payload.statusId ? statusLabel(payload.statusId) : "—";

  if (payload.event === "subscription.frozenEnding") {
    return (
      `🧊 ${name}\n` +
      `Статус: ${status}\n\n` +
      `Заморозка скоро закончится: осталось ${payload.freezeDaysLeft ?? "—"} дн.\n` +
      `После окончания можно вернуться к тренировкам.\n\n` +
      `Нажми кнопку ниже, чтобы продлить/связаться.`
    );
  }

  // expiringSoon
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

// function renderMessage (c: {
// 	event: string;
// 	userId: number;
// 	remainingVisits: number;
// 	daysToEnd: number | null;
// 	freezeDaysLeft: number | null;
// 	endDateEffective: string | null;
// })
// {
// 	if (c.event === 'subscription.frozenEnding')
// 	{
// 		return `🧊 Заморозка скоро закончится.\n` +
// 			`Клиент ${c.userId}\n` +
// 			`Осталось дней: ${c.freezeDaysLeft ?? '—'}\n` +
// 			`После окончания можно вернуться к тренировкам.`;
// 	}

// 	// expiringSoon
// 	return `⏳ Абонемент подходит к концу.\n` +
// 		`Клиент ${c.userId}\n` +
// 		`Осталось посещений: ${c.remainingVisits}\n` +
// 		`Дней до конца: ${c.daysToEnd ?? '—'}\n` +
// 		`${c.endDateEffective ? `Дата окончания: ${c.endDateEffective}\n` : ''}` +
// 		`Напиши администратору, чтобы продлить.`;
// }

async function pollOnce ()
{
	const now = new Date();
	const token = await getCachedAccessToken();

	for (const userId of WATCH_USER_IDS)
	{
		const chatId = CRM_USER_TO_CHAT.get(userId);

		if (!chatId)
		{
			console.warn('skip user (no chatId mapping):', userId);
			continue;
		}

		let subs;

		try
		{
			subs = await getUserSubscriptions(token, userId);
		}
		catch (e)
		{
			console.error('moyklass fetch failed', { userId, error: String(e) });
			continue;
		}

		const candidates = pickCandidates(subs, userId, THR, now);

		for (const c of candidates) {
			// “есть свежая замена” — молчим
			if (hasFreshReplacement(subs, c, THR, now)) {
				continue;
			}

			const key = dailyKey({ userId, userSubId: c.userSubscriptionId, event: c.event });

			if (dedupe.seen(key)) {
        console.log("dedup skip", { userId, event: c.event, userSubId: c.userSubscriptionId });
				continue;
			}

      let userName: string | undefined;

      try {
        const info = await getUserInfo(token, userId);
        userName = info.name;
      } catch (e) {
        // не критично для MVP
        console.warn("user info fetch failed", { userId, error: String(e) });
      }

      const text = renderMessage({
        event: c.event,
        userId,
        userName,
        remainingVisits: c.remainingVisits,
        daysToEnd: c.daysToEnd,
        freezeDaysLeft: c.freezeDaysLeft,
        endDateEffective: c.endDateEffective,
        statusId: subs.find((x) => x.id === c.userSubscriptionId)?.statusId,
      });

      const replyMarkup = buildKeyboard(userId, c.userSubscriptionId);

      try {
        await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
        dedupe.remember(key);
        console.log("sent", { userId, chatId, event: c.event, userSubId: c.userSubscriptionId });
      } catch (e) {
        console.error("tg send failed", { userId, chatId, error: String(e) });
      }
		}
	}
}

// MVP: логируем chatId на /start, чтобы можно было быстро собрать CRM_USER_TO_CHAT
bot.on('message', async (msg) => {
	if (!msg?.chat?.id) return;

	const chatId = msg.chat.id;

	if (msg.text?.startsWith('/start')) {
		console.log('tg /start', { chatId });
		await bot.sendMessage(chatId, 'Привет! Я на связи. (MVP polling из МойКласс)');
	}
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  if (!chatId) return;

  // чтобы “крутилка” в TG исчезала
  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (data.startsWith("renew:")) {
    await bot.sendMessage(
      chatId,
      "💳 Ок. Для продления: напиши администратору или перейди по ссылке оплаты (пока заглушка)."
    );
    return;
  }

  if (data.startsWith("contact:")) {
    await bot.sendMessage(chatId, "✍️ Ок. Администратор свяжется с тобой (пока заглушка).");
    return;
  }

  if (data.startsWith("stop:")) {
    await bot.sendMessage(chatId, "🚫 Понял. Больше не буду присылать уведомления (MVP: заглушка).");
    return;
  }
});

console.log('Worker polling started');
console.log('MVP poll config', { WATCH_USER_IDS, POLL_INTERVAL_SEC, THR });

(async () => {
		// первый прогон сразу
		await pollOnce();

		setInterval(async () => {
				try {
					await pollOnce();
				} catch (e) {
					console.error('pollOnce failed', String(e));
				}
			}, POLL_INTERVAL_SEC * 1000);
})()
.catch(e => {
  console.error('worker init failed', String(e));
  process.exit(1);
});


// import TelegramBot from "node-telegram-bot-api";
// import { Pool } from "pg";

// const token = process.env.TG_BOT_TOKEN!;
// if (!token) {
//   console.error("TG_BOT_TOKEN is empty");
//   process.exit(1);
// }

// // Без домена — polling; потом переведём на webhook
// const bot = new TelegramBot(token, { polling: true });

// const pool = new Pool({
//   host: process.env.POSTGRES_HOST,
//   port: Number(process.env.POSTGRES_PORT || 5432),
//   database: process.env.POSTGRES_DB,
//   user: process.env.POSTGRES_USER,
//   password: process.env.POSTGRES_PASSWORD,
// });

// bot.on("message", async (msg) => {
//   const chatId = msg.chat.id;

//   if (msg.text?.match(/^\/start/)) {
//     await bot.sendMessage(chatId, "Привет! Я на связи. Пока работаю в режиме polling; webhook включим, когда появится домен.");
//   }

//   // TODO: на Этапе 1 — писать входящие в messages (БД), обрабатывать /stop и т.п.
// });

// console.log("Worker polling started");
