import TelegramBot from "node-telegram-bot-api";
import { Pool } from "pg";

const token = process.env.TG_BOT_TOKEN!;
if (!token) {
  console.error("TG_BOT_TOKEN is empty");
  process.exit(1);
}

// Без домена — polling; потом переведём на webhook
const bot = new TelegramBot(token, { polling: true });

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text?.match(/^\/start/)) {
    await bot.sendMessage(chatId, "Привет! Я на связи. Пока работаю в режиме polling; webhook включим, когда появится домен.");
  }

  // TODO: на Этапе 1 — писать входящие в messages (БД), обрабатывать /stop и т.п.
});

console.log("Worker polling started");
