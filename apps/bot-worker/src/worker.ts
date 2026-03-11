import TelegramBot from "node-telegram-bot-api";
import { getToken, getUserSubscriptions } from "./moyklass.js";
import { InMemoryDedupe, dailyKey } from "./dedupe.js";
import { pickCandidates, hasFreshReplacement } from "./rules.js";
import { getUserInfo } from "./moyklass-users.js";
import {
  dbPing,
  upsertLinkByPhone,
  upsertLinkByUserId,
  setCrmUserIdForChat,
  deactivateChat,
  unlinkPhone,
  unlinkUserId,
  getLinkByChat,
  getChatIdByCrmUserId,
} from "./db.js";

/**
 * bot-worker (MVP)
 *
 * 1) Polling:
 * - берём WATCH_USER_IDS (для демо или для “наблюдаемых” клиентов)
 * - тянем абонементы /company/userSubscriptions
 * - считаем кандидатов ("скоро закончится" / "заморозка заканчивается")
 * - если нет "свежей замены" и нет дедупа -> шлём уведомление в TG
 *
 * 2) Привязка TG ↔ MoyKlass:
 * - по телефону: пользователь отправляет контакт -> ищем users?phone -> сохраняем связь
 * - по userId: пользователь вводит id -> сохраняем связь
 *
 * Хранилище связей: Postgres таблица tg_links (persist).
 * Дедуп уведомлений: in-memory (только на время жизни контейнера).
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

// TODO: это temp логика, тянет из .env переменные — убрать в production
// версии!
const WATCH_USER_IDS = parseIntList(process.env.WATCH_USER_IDS);
const CRM_USER_TO_CHAT = parseMapUserToChat(process.env.CRM_USER_TO_CHAT);
const DENY_USER_IDS = new Set(parseIntList(process.env.MVP_DENY_USER_IDS));

const POLL_INTERVAL_SEC = envNum("POLL_INTERVAL_SEC", 300);
const THR = {
  daysToEnd: envNum("DAYS_TO_END", 5),
  remainVisits: envNum("REMAIN_VISITS", 1),
  freezeEndDays: envNum("FREEZE_END_DAYS", 3),
};

const dedupe = new InMemoryDedupe(26 * 60 * 60 * 1000);
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });


/* -------------------- polling core -------------------- */

async function pollOnce() {
  const now = new Date();
  const token = await getCachedAccessToken();

  for (const userId of WATCH_USER_IDS) {
    if (DENY_USER_IDS.has(userId)) continue;

    const chatId = await resolveChatIdForUser(userId);
    if (!chatId) continue;

    let subs: any[];
    try {
      subs = await getUserSubscriptions(token, userId);
    } catch (e) {
      console.error("moyklass fetch failed", { userId, error: String(e) });
      continue;
    }

    const candidates = pickCandidates(subs, userId, THR, now);

    for (const c of candidates) {
      if (DENY_USER_IDS.has(userId)) continue;
      if (hasFreshReplacement(subs, c, THR, now)) continue;

      const key = dailyKey({ userId, userSubId: c.userSubscriptionId, event: c.event });
      if (dedupe.seen(key)) continue;

      let userName: string | undefined;
      try {
        const info = await getUserInfo(token, userId);
        userName = info.name;
      } catch {}

      const statusId = subs.find((x) => x.id === c.userSubscriptionId)?.statusId;
      const text = renderNotifyMessage({
        event: c.event,
        userId,
        userName,
        remainingVisits: c.remainingVisits,
        daysToEnd: c.daysToEnd,
        freezeDaysLeft: c.freezeDaysLeft,
        endDateEffective: c.endDateEffective,
        statusId,
      });

      try {
        await bot.sendMessage(chatId, text, {
          reply_markup: buildNotifyKeyboard(userId, c.userSubscriptionId)
        });

        dedupe.remember(key);
        console.log("sent", { userId, chatId, event: c.event, userSubId: c.userSubscriptionId });
      } catch (e) {
        console.error("tg send failed", { userId, chatId, error: String(e) });
      }
    }
  }
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getCachedAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < cachedToken.expiresAtMs - 60_000) {
    return cachedToken.token;
  }

  const t = await getToken(MOYKLASS_API_KEY);

  const ttlMs = t.expiresAt
    ? Math.max(5 * 60 * 1000, new Date(t.expiresAt).getTime() - now)
    : envNum("MOYKLASS_TOKEN_TTL_SEC", 7200) * 1000;

  cachedToken = { token: t.accessToken, expiresAtMs: now + ttlMs };
  return cachedToken.token;
}


/**
 * Находим chatId для конкретного CRM userId:
 * 1) Postgres tg_links (главный источник истины)
 * 2) fallback из .env только если явно включён
 */
async function resolveChatIdForUser(userId: number) {
  if (USE_DB_LINKS) {
    const fromDb = await getChatIdByCrmUserId(userId);
    if (fromDb) return fromDb;
  }

  if (USE_ENV_CHAT_MAP) {
    return CRM_USER_TO_CHAT.get(userId) ?? null;
  }

  return null;
}


/* -------------------- telegram ui -------------------- */

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
          { text: "🔕 Не беспокоить", callback_data: "menu:dnd" },
          { text: "❌ Отвязать", callback_data: "menu:unlink" },
        ],
      ],
    },
  };
}

async function sendMenu(chatId: number) {
  await bot.sendMessage(chatId, "Меню:", buildMainMenu());
}

const chatState = new Map<number, { mode: "await_link_user_id" }>();

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
    const link = await getLinkByChat(chatId);
    await bot.sendMessage(
      chatId,
      link
        ? `Твоя привязка:\nchat_id: ${link.chatId}\nphone: ${link.phone ?? "—"}\ncrm_user_id: ${link.crmUserId ?? "—"}\nactive: ${link.isActive}`
        : "Привязки нет. Нажми “📱 Привязать телефон” или “🆔 Привязать userId”."
    );
    return;
  }

  if (data === "menu:status") {
    try {
      await dbPing();
    } catch (e) {
      await bot.sendMessage(chatId, `DB недоступна: ${String(e)}`);
      return;
    }

    const link = await getLinkByChat(chatId);
    if (!link?.crmUserId || !link.isActive) {
      await bot.sendMessage(chatId, "Нет активной привязки к userId. Сначала привяжи телефон или userId.");
      return;
    }

    try {
      const token = await getCachedAccessToken();
      const subs = await getUserSubscriptions(token, link.crmUserId);
      const candidates = pickCandidates(subs, link.crmUserId, THR, new Date());

      if (candidates.length === 0) {
        await bot.sendMessage(chatId, "Сейчас нет событий: абонементы не заканчиваются по порогам.");
        return;
      }

      const lines = candidates.slice(0, 5).map((c) => {
        const st = subs.find((x) => x.id === c.userSubscriptionId)?.statusId ?? 0;
        return `• ${c.event} | subId ${c.userSubscriptionId} | статус ${getStatusLabel(st)} | остаток ${c.remainingVisits} | дней ${c.daysToEnd ?? "—"}`;
      });

      await bot.sendMessage(chatId, `Статус по userId ${link.crmUserId}:\n${lines.join("\n")}`);
    } catch (e) {
      await bot.sendMessage(chatId, `Ошибка MoyKlass: ${String(e)}`);
    }

    return;
  }

  if (data === "menu:dnd" || data.startsWith("stop:")) {
    await deactivateChat(chatId);
    await bot.sendMessage(chatId, "🚫 Ок. Уведомления отключены. (Можно включить снова через привязку)");
    return;
  }

  if (data === "menu:unlink") {
    await deactivateChat(chatId);
    await unlinkPhone(chatId);
    await unlinkUserId(chatId);
    await bot.sendMessage(chatId, "❌ Привязка очищена.");
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
    await bot.sendMessage(chatId, "Привет! Я бот InMotion. Вот меню 👇");
    await sendMenu(chatId);
    return;
  }

  if (text.startsWith("/menu")) {
    await sendMenu(chatId);
    return;
  }

  if (text.startsWith("/me")) {
    const link = await getLinkByChat(chatId);
    await bot.sendMessage(
      chatId,
      link
        ? `Твоя привязка:\nchat_id: ${link.chatId}\nphone: ${link.phone ?? "—"}\ncrm_user_id: ${link.crmUserId ?? "—"}\nactive: ${link.isActive}`
        : "Привязки нет. Нажми “📱 Привязать телефон” или “🆔 Привязать userId”."
    );
    return;
  }

  if (text.startsWith("/status")) {
    try {
      await dbPing();
    } catch (e) {
      await bot.sendMessage(chatId, `DB недоступна: ${String(e)}`);
      return;
    }

    const link = await getLinkByChat(chatId);
    if (!link?.crmUserId || !link.isActive) {
      await bot.sendMessage(chatId, "Нет активной привязки к userId. Сначала привяжи телефон или userId.");
      return;
    }

    try {
      const token = await getCachedAccessToken();
      const subs = await getUserSubscriptions(token, link.crmUserId);
      const candidates = pickCandidates(subs, link.crmUserId, THR, new Date());

      if (candidates.length === 0) {
        await bot.sendMessage(chatId, "Сейчас нет событий: абонементы не заканчиваются по порогам.");
        return;
      }

      const lines = candidates.slice(0, 5).map((c) => {
        const st = subs.find((x) => x.id === c.userSubscriptionId)?.statusId ?? 0;
        return `• ${c.event} | subId ${c.userSubscriptionId} | статус ${getStatusLabel(st)} | остаток ${c.remainingVisits} | дней ${c.daysToEnd ?? "—"}`;
      });

      await bot.sendMessage(chatId, `Статус по userId ${link.crmUserId}:\n${lines.join("\n")}`);
    } catch (e) {
      await bot.sendMessage(chatId, `Ошибка MoyKlass: ${String(e)}`);
    }

    return;
  }

  if (text.startsWith("/unlink_phone")) {
    await unlinkPhone(chatId);
    await bot.sendMessage(chatId, "Ок. Телефон отвязан.");
    return;
  }

  if (text.startsWith("/unlink_id")) {
    await unlinkUserId(chatId);
    await bot.sendMessage(chatId, "Ок. userId отвязан.");
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

      if (users.length === 0) {
        await bot.sendMessage(chatId, `Не нашёл клиента в МойКласс по номеру ${phone}.`);
        return;
      }

      if (users.length === 1) {
        const u = users[0];
        await setCrmUserIdForChat(chatId, u.id);
        await bot.sendMessage(chatId, `✅ Привязал.\nМойКласс: ${u.name ?? "без имени"} (id ${u.id})\nТелефон: ${phone}`);
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
    } catch (e) {
      await bot.sendMessage(chatId, `Ошибка при поиске в МойКласс: ${String(e)}`);
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

    await upsertLinkByUserId(chatId, id);
    chatState.delete(chatId);
    await bot.sendMessage(chatId, `✅ Привязал userId ${id}. Напиши /status чтобы проверить.`);
    return;
  }
});


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
  // "+7 (999) 123-45-67" -> "79991234567"
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
  // callback_data <= 64 bytes -> короткий формат
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
