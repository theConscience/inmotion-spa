import express from "express";
import { Pool } from "pg";

const {
  ADMIN_TOKEN,
  POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD,
  PORT
} = process.env;

const pool = new Pool({
  host: POSTGRES_HOST,
  port: Number(POSTGRES_PORT || 5432),
  database: POSTGRES_DB,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.get("authorization") || "";
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/notify", requireAdmin, async (req, res) => {
  // TODO: валидация zod и запись jobs в БД — на Этапе 1
  const queued = Array.isArray(req.body?.targets) ? req.body.targets.length : 0;
  res.json({ queued });
});

app.post("/bot/webhook", (_req, res) => {
  // пока не используем — до домена работаем polling'ом в worker
  res.json({ ok: true, mode: "webhook-received" });
});

const PORT_NUM = Number(PORT || 3000);
app.listen(PORT_NUM, () => console.log(`API on :${PORT_NUM}`));
