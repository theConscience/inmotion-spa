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
 * Бизнес-логика:
 * 1) Polling по WATCH_USER_IDS: проверяем userSubscriptions в MoyKlass,
 *    если "заканчивается" и нет "свежей замены" -> шлём сообщение в TG.
 *
 * 2) Привязка TG <-> CRM:
 *    - /link: запрос контакта -> phone -> MoyKlass users?phone -> сохраняем в Postgres
 *    - /linkid <id>: привязка по userId -> сохраняем в Postgres
 *    - /unlink: отключить канал (is_active=false)
 *    - /unlink_phone: удалить телефон из привязки
 *    - /unlink_id: удалить userId из привязки
 *    - /me: показать что привязано
 *
 * MVP-решение: без полноценной авторизации и без сложных конфликтов.
 */

// /**
//  * БИЗНЕС-ЛОГИКА:
//  * Мы храним список crm userId, которых мониторим (watch list),
//  * и отправляем уведомления в Telegram тем, у кого:
//  * - абонемент скоро закончится, или
//  * - заморозка скоро закончится,
//  * и при этом нет "свежей замены" (нового активного абонемента на тот же контекст).
//  *
//  * MVP сделан без БД: дедуп и привязки — in-memory (переживают только жизнь контейнера).
//  */

function parseIntList(s?: string) {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

function parseMapUserToChat(s?: string) {
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

function envNum(k: string, def: number) {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : def;
}

function statusLabel(statusId: number) {
  if (statusId === 2) return "Активен";
  if (statusId === 3) return "Заморожен";
  if (statusId === 4) return "Окончен";
  return "Не активен";
}

function normalizePhone(input: string) {
  const digits = input.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

function buildKeyboard(userId: number, userSubId: number) {
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

async function findMoyklassUsersByPhone(token: string, phone: string) {
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

  const j = (await r.json()) as { users?: Array<{ id: number; name?: string }> };
  return j.users ?? [];
}

/* -------------------- env -------------------- */

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
const DENY_USER_IDS = new Set(parseIntList(process.env.MVP_DENY_USER_IDS));

const POLL_INTERVAL_SEC = envNum("POLL_INTERVAL_SEC", 300);
const THR = {
  daysToEnd: envNum("DAYS_TO_END", 5),
  remainVisits: envNum("REMAIN_VISITS", 1),
  freezeEndDays: envNum("FREEZE_END_DAYS", 3),
};

const dedupe = new InMemoryDedupe(26 * 60 * 60 * 1000);
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getCachedAccessToken() {
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
 * 1) сначала ищем в Postgres (persist)
 * 2) затем fallback из .env (для демо/быстрого теста)
 */
async function resolveChatIdForUser(userId: number) {
  const fromDb = await getChatIdByCrmUserId(userId);
  if (fromDb) return fromDb;
  return CRM_USER_TO_CHAT.get(userId) ?? null;
}

/* -------------------- polling core -------------------- */

async function pollOnce() {
  const now = new Date();
  const token = await getCachedAccessToken();

  for (const userId of WATCH_USER_IDS) {
    if (DENY_USER_IDS.has(userId)) continue;

    const chatId = await resolveChatIdForUser(userId);
    if (!chatId) {
      console.warn("skip user (no chatId mapping):", userId);
      continue;
    }

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
      const text = renderMessage({
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
        await bot.sendMessage(chatId, text, { reply_markup: buildKeyboard(userId, c.userSubscriptionId) });
        dedupe.remember(key);
        console.log("sent", { userId, chatId, event: c.event, userSubId: c.userSubscriptionId });
      } catch (e) {
        console.error("tg send failed", { userId, chatId, error: String(e) });
      }
    }
  }
}

/* -------------------- telegram commands -------------------- */

async function sendMenu(chatId: number) {
  const kb = {
    keyboard: [
      [{ text: "📱 Привязать телефон", request_contact: true }],
      [{ text: "🆔 Привязать userId" }],
      [{ text: "👤 /me" }, { text: "📊 /status" }],
      [{ text: "🔌 /unlink" }],
    ],
    resize_keyboard: true,
  };

  await bot.sendMessage(chatId, "Меню:", { reply_markup: kb });
}

const chatState = new Map<number, { mode: "await_link_user_id" }>();

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  const text = (msg.text || "").trim();

  if (text.startsWith("/start")) {
    // await bot.sendMessage(chatId, "Привет! Открой меню: /menu");
    await bot.sendMessage(chatId, "Привет! Я бот InMotion. Вот меню 👇");
    await sendMenu(chatId);
    return;
  }

  if (text.startsWith("/menu")) {
    await sendMenu(chatId);
    return;
  }

  if (text === "🆔 Привязать userId" || text.startsWith("/linkid")) {
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const userId = Number(parts[1]);
      if (!Number.isFinite(userId)) {
        await bot.sendMessage(chatId, "Нужен числовой userId. Пример: /linkid 5170959");
        return;
      }
      await upsertLinkByUserId(chatId, userId);
      await bot.sendMessage(chatId, `✅ Привязал по userId: ${userId}\nПроверить: /me`);
      return;
    }

    chatState.set(chatId, { mode: "await_link_user_id" });
    await bot.sendMessage(chatId, "Введи userId ученика (цифры). Пример: 5170959");
    return;
  }

  // ждём ввод userId после кнопки
  const st = chatState.get(chatId);
  if (st?.mode === "await_link_user_id") {
    chatState.delete(chatId);
    const userId = Number(text);
    if (!Number.isFinite(userId)) {
      await bot.sendMessage(chatId, "Не похоже на число. Ещё раз: нажми “🆔 Привязать userId”.");
      return;
    }
    await upsertLinkByUserId(chatId, userId);
    await bot.sendMessage(chatId, `✅ Привязал по userId: ${userId}\nПроверить: /me`);
    return;
  }

  if (text.startsWith("/unlink")) {
    await deactivateChat(chatId);
    await bot.sendMessage(chatId, "🔌 Ок. Канал отключён (is_active=false). Чтобы включить снова — сделай /link или /linkid.");
    return;
  }

  if (text.startsWith("/unlink_phone")) {
    await unlinkPhone(chatId);
    await bot.sendMessage(chatId, "✅ Телефон отвязан. Проверить: /me");
    return;
  }

  if (text.startsWith("/unlink_id")) {
    await unlinkUserId(chatId);
    await bot.sendMessage(chatId, "✅ userId отвязан. Проверить: /me");
    return;
  }

  if (text.startsWith("/me") || text === "👤 /me") {
    const link = await getLinkByChat(chatId);
    if (!link) {
      await bot.sendMessage(chatId, "Пока нет привязки. /link (телефон) или /linkid (userId).");
      return;
    }

    await bot.sendMessage(
      chatId,
      [
        "👤 Твоя привязка (Postgres):",
        `chat_id: ${link.chatId}`,
        `is_active: ${link.isActive}`,
        `phone: ${link.phone ?? "—"}`,
        `crm_user_id: ${link.crmUserId ?? "—"}`,
        "",
        "Команды:",
        "/unlink — отключить канал",
        "/unlink_phone — отвязать телефон",
        "/unlink_id — отвязать userId",
      ].join("\n")
    );
    return;
  }

  if (text.startsWith("/status") || text === "📊 /status") {
    const lines: string[] = [];
    lines.push("📊 InMotion bot-worker status (MVP)");
    lines.push(`poll interval: ${POLL_INTERVAL_SEC}s`);
    lines.push(`THR: daysToEnd=${THR.daysToEnd}, remainVisits=${THR.remainVisits}, freezeEndDays=${THR.freezeEndDays}`);
    lines.push(`WATCH_USER_IDS: ${WATCH_USER_IDS.length ? WATCH_USER_IDS.join(", ") : "—"}`);
    lines.push(`DENY_USER_IDS(env): ${DENY_USER_IDS.size ? Array.from(DENY_USER_IDS).join(", ") : "—"}`);

    try {
      await dbPing();
      lines.push("db: ok");
    } catch (e) {
      lines.push(`db: error ${String(e)}`);
    }

    await bot.sendMessage(chatId, lines.join("\n"));
    return;
  }

  // allow manual phone typing as shortcut
  if (/\d/.test(text) && text.length >= 10) {
    const phone = normalizePhone(text);
    if (phone.length >= 10) {
      await upsertLinkByPhone(chatId, phone);
      await bot.sendMessage(chatId, `📱 Ок. Телефон сохранён: ${phone}\nТеперь попробую найти клиента в МойКласс...`);

      try {
        const token = await getCachedAccessToken();
        const users = await findMoyklassUsersByPhone(token, phone);

        if (!users.length) {
          await bot.sendMessage(chatId, `Не нашёл клиентов в МойКласс по телефону ${phone}.`);
          return;
        }

        if (users.length === 1) {
          await setCrmUserIdForChat(chatId, users[0].id);
          await bot.sendMessage(chatId, `✅ Нашёл и привязал userId: ${users[0].id} (${users[0].name ?? "без имени"})\n/me`);
          return;
        }

        const lines = users.slice(0, 5).map((u) => `• ${u.id} — ${u.name ?? "без имени"}`).join("\n");
        await bot.sendMessage(
          chatId,
          `Нашёл несколько клиентов по этому телефону:\n${lines}\n\nВыбери правильный userId и привяжи: /linkid <id>`
        );
      } catch (e) {
        await bot.sendMessage(chatId, `Ошибка поиска в МойКласс: ${String(e)}`);
      }

      return;
    }
  }
});

bot.on("contact", async (msg) => {
  const chatId = msg.chat?.id;
  const phoneRaw = msg.contact?.phone_number;
  if (!chatId || !phoneRaw) return;

  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    await bot.sendMessage(chatId, "Не смог распознать номер. Попробуй ещё раз.");
    return;
  }

  await upsertLinkByPhone(chatId, phone);
  await bot.sendMessage(chatId, `📱 Телефон сохранён: ${phone}\nИщу клиента в МойКласс...`);

  try {
    const token = await getCachedAccessToken();
    const users = await findMoyklassUsersByPhone(token, phone);

    if (!users.length) {
      await bot.sendMessage(chatId, `Не нашёл клиентов в МойКласс по телефону ${phone}.`);
      return;
    }

    if (users.length === 1) {
      await setCrmUserIdForChat(chatId, users[0].id);
      await bot.sendMessage(chatId, `✅ Привязал: ${users[0].name ?? "без имени"} (id ${users[0].id})\n/me`);
      return;
    }

    const lines = users.slice(0, 5).map((u) => `• ${u.id} — ${u.name ?? "без имени"}`).join("\n");
    await bot.sendMessage(
      chatId,
      `Нашёл несколько клиентов по этому телефону:\n${lines}\n\nВыбери правильный userId и привяжи: /linkid <id>`
    );
  } catch (e) {
    await bot.sendMessage(chatId, `Ошибка поиска в МойКласс: ${String(e)}`);
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";
  if (!chatId) return;

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  if (data.startsWith("renew:")) {
    await bot.sendMessage(chatId, "💳 Ок. Для продления: напиши администратору (MVP).");
    return;
  }

  if (data.startsWith("contact:")) {
    await bot.sendMessage(chatId, "✍️ Ок. Администратор свяжется с тобой (MVP).");
    return;
  }

  if (data.startsWith("stop:")) {
    const parts = data.split(":");
    const userId = Number(parts[1]);
    if (Number.isFinite(userId)) {
      await bot.sendMessage(chatId, `🚫 Ок. Для полного opt-out сделаем позже. Сейчас можешь отключить канал: /unlink`);
    } else {
      await bot.sendMessage(chatId, "🚫 Ок. Отключение уведомлений сделаем в следующем шаге.");
    }
  }
});

/* -------------------- boot -------------------- */

console.log("Worker polling started");
console.log("MVP poll config", { WATCH_USER_IDS, POLL_INTERVAL_SEC, THR });

(async () => {
  try {
    await dbPing();
    console.log("db ok");
  } catch (e) {
    console.error("db ping failed", String(e));
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
