const BASE = 'https://api.moyklass.com/v1/company';

export type MoyklassToken = {
	accessToken: string;
	expiresAt?: string; // ISO
};

export async function getToken (apiKey: string) : Promise<MoyklassToken> {
	const r = await fetch(`${BASE}/auth/getToken`,
		{
			method: 'POST',
			headers:
			{
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ apiKey })
		});

	if (!r.ok)
	{
		const t = await r.text().catch(() => '');
		throw new Error(`moyklass getToken failed: ${r.status} ${t}`);
	}

	return await r.json() as MoyklassToken;
}

function authHeaders (token: string)
{
	return {
		'x-access-token': token,
		'Content-Type': 'application/json'
	};
}

export type UserSubscription =
{
	id: number;
	userId: number;
	subscriptionId: number;

	beginDate?: string;
	endDate?: string;
	overDate?: string;

	visitCount: number;
	visitedCount: number;

	statusId: number; // 1..4
	freezeFrom?: string;
	freezeTo?: string;

	classIds?: number[];
	courseIds?: number[];

	externalId?: string;
};

export async function getUserSubscriptions(token: string, userId: number) {
  const qs = new URLSearchParams();
  qs.set("userId", String(userId));
  qs.set("limit", "500");

  // ВАЖНО: statusId у них array-of-int → передаём повторяющимися параметрами
  qs.append("statusId", "2"); // active
  qs.append("statusId", "3"); // frozen

  const r = await fetch(`${BASE}/userSubscriptions?${qs.toString()}`, {
    headers: authHeaders(token),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`moyklass userSubscriptions failed: ${r.status} ${t}`);
  }

  const j = (await r.json()) as { subscriptions?: UserSubscription[] };
  return j.subscriptions ?? [];
}
