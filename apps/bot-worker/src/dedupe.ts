type Entry = { until: number };

export class InMemoryDedupe
{
	private map = new Map<string, Entry>();

	constructor (private ttlMs: number)
	{
		setInterval(() =>
			{
				this.gc();
			}, 60_000).unref();
	}

	public seen (key: string)
	{
		const e = this.map.get(key);
		if (!e) return false;

		if (Date.now() > e.until)
		{
			this.map.delete(key);
			return false;
		}

		return true;
	}

	public remember (key: string)
	{
		this.map.set(key, { until: Date.now() + this.ttlMs });
	}

	private gc ()
	{
		const now = Date.now();

		for (const [k, v] of this.map.entries())
		{
			if (now > v.until)
			{
				this.map.delete(k);
			}
		}
	}
}

export function dailyKey (parts: { userId: number; userSubId: number; event: string })
{
	const d = new Date();
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');

	return `${parts.userId}:${parts.userSubId}:${parts.event}:${y}${m}${dd}`;
}
