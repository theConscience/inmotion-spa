import type { UserSubscription } from './moyklass.js';

export type Thresholds =
{
	daysToEnd: number;
	remainVisits: number;
	freezeEndDays: number;
};

export type CandidateEvent =
{
	event: 'subscription.expiringSoon' | 'subscription.frozenEnding';
	userId: number;
	userSubscriptionId: number;
	subscriptionId: number;

	remainingVisits: number;
	daysToEnd: number | null;
	freezeDaysLeft: number | null;

	endDateEffective: string | null; // yyyy-mm-dd
};

function parseDate (s?: string) : Date | null
{
	if (!s) return null;
	const d = new Date(s);
	if (Number.isNaN(+d)) return null;
	return d;
}

function daysBetweenCeil (a: Date, b: Date)
{
	// ceil((b-a)/day)
	return Math.ceil((+b - +a) / 86400000);
}

export function calcDaysToEnd (us: UserSubscription, now: Date) : { days: number | null; eff: string | null }
{
	const d = parseDate(us.overDate) ?? parseDate(us.endDate);
	if (!d) return { days: null, eff: null };
	return { days: daysBetweenCeil(now, d), eff: us.overDate ?? us.endDate ?? null };
}

export function calcFreezeDaysLeft (us: UserSubscription, now: Date) : number | null
{
	const to = parseDate(us.freezeTo);
	if (!to) return null;

	return daysBetweenCeil(now, to);
}

export function pickCandidates (subs: UserSubscription[], userId: number, thr: Thresholds, now: Date) : CandidateEvent[]
{
	const out: CandidateEvent[] = [];

	for (const us of subs)
	{
		const remaining = (us.visitCount ?? 0) - (us.visitedCount ?? 0);
		const { days, eff } = calcDaysToEnd(us, now);
		const freezeLeft = calcFreezeDaysLeft(us, now);

		// expiringSoon: активный и близко конец по дням или по остаткам
		if (us.statusId === 2)
		{
			const byDays = (days !== null) && (days <= thr.daysToEnd);
			const byVisits = remaining <= thr.remainVisits;

			if (byDays || byVisits)
			{
				out.push(
					{
						event: 'subscription.expiringSoon',
						userId,
						userSubscriptionId: us.id,
						subscriptionId: us.subscriptionId,
						remainingVisits: remaining,
						daysToEnd: days,
						freezeDaysLeft: freezeLeft,
						endDateEffective: eff
					});
			}
		}

		// frozenEnding: есть freezeTo и скоро заканчивается
		if (freezeLeft !== null && freezeLeft >= 0 && freezeLeft <= thr.freezeEndDays)
		{
			out.push(
				{
					event: 'subscription.frozenEnding',
					userId,
					userSubscriptionId: us.id,
					subscriptionId: us.subscriptionId,
					remainingVisits: remaining,
					daysToEnd: days,
					freezeDaysLeft: freezeLeft,
					endDateEffective: eff
				});
		}
	}

	return out;
}

// MVP-проверка “есть свежая замена”
export function hasFreshReplacement (allSubs: UserSubscription[], candidate: CandidateEvent, thr: Thresholds, now: Date)
{
	for (const us of allSubs)
	{
		if (us.id === candidate.userSubscriptionId) continue;
		if (us.statusId !== 2) continue;

		const remaining = (us.visitCount ?? 0) - (us.visitedCount ?? 0);
		const { days } = calcDaysToEnd(us, now);

		const goodByDays = (days === null) ? true : (days > thr.daysToEnd);
		const goodByVisits = remaining > thr.remainVisits;

		if (goodByDays && goodByVisits)
		{
			// да, это грубо: не сравниваем “тот же зал/класс”, просто “есть другой активный хороший”
			return true;
		}
	}

	return false;
}
