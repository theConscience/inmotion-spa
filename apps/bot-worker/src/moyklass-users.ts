const BASE = "https://api.moyklass.com/v1/company";

export type MkUser = {
  id: number;
  name?: string;
  phone?: number | string;
};

type CacheEntry = { until: number; value: MkUser };

const cache = new Map<number, CacheEntry>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

function authHeaders(token: string) {
  return { "x-access-token": token, "Content-Type": "application/json" };
}

export async function getUserInfo(token: string, userId: number): Promise<MkUser> {
  const hit = cache.get(userId);
  if (hit && Date.now() < hit.until) return hit.value;

  const r = await fetch(`${BASE}/users/${userId}`, {
    headers: authHeaders(token),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`moyklass users/${userId} failed: ${r.status} ${t}`);
  }

  const j = (await r.json()) as any;

  const value: MkUser = {
    id: j.id,
    name: j.name,
    phone: j.phone,
  };

  cache.set(userId, { until: Date.now() + TTL_MS, value });

  return value;
}
