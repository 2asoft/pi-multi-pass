export type SelectionQuotaKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";

export interface SelectionBucket {
	id: string;
	members: string[];
}

export interface SelectionQuotaResult {
	kind: SelectionQuotaKind;
	score: number;
}

export type QuotaSelectionPlan =
	| { kind: "selected"; providerName: string }
	| { kind: "round-robin"; bucketId: string; providerNames: string[] }
	| { kind: "unavailable" };

export function selectionProviderName(setId: string): string {
	const slug = setId
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return `multi-pass-${slug || "set"}`;
}

export function deduplicateSelectionSets<T extends { id: string }>(sets: T[]): T[] {
	const providerNames = new Set<string>();
	return sets.filter((set) => {
		const providerName = selectionProviderName(set.id);
		if (providerNames.has(providerName)) return false;
		providerNames.add(providerName);
		return true;
	});
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function parseSelectionBuckets(
	value: unknown,
	validProviderNames: ReadonlySet<string>,
): SelectionBucket[] {
	if (!Array.isArray(value)) return [];

	const bucketIds = new Set<string>();
	const assignedProviders = new Set<string>();
	const buckets: SelectionBucket[] = [];
	for (const candidate of value) {
		const raw = getRecord(candidate);
		const id = typeof raw?.id === "string" ? raw.id.trim() : "";
		if (!id || bucketIds.has(id)) continue;
		bucketIds.add(id);

		const members = (Array.isArray(raw?.members) ? raw.members : [])
			.filter((member): member is string => typeof member === "string")
			.map((member) => member.trim())
			.filter((member) => {
				if (!validProviderNames.has(member) || assignedProviders.has(member)) return false;
				assignedProviders.add(member);
				return true;
			});
		if (members.length > 0) buckets.push({ id, members });
	}
	return buckets;
}

export function getBlockedQuotaRetryAt(
	windows: Array<{ remaining: number | undefined; resetAtSeconds?: number }>,
): number | undefined {
	const resetTimes: number[] = [];
	for (const window of windows) {
		if (window.remaining !== undefined && window.remaining <= 5 && window.resetAtSeconds !== undefined) {
			resetTimes.push(window.resetAtSeconds);
		}
	}
	return resetTimes.length > 0 ? Math.max(...resetTimes) * 1000 : undefined;
}

export function getFailureSuppressionUntil(
	now: number,
	fallbackDurationMs: number,
	reportedRetryAt?: number,
): number {
	return reportedRetryAt !== undefined && reportedRetryAt > now
		? reportedRetryAt
		: now + fallbackDurationMs;
}

export function selectEligibleBuckets(
	buckets: SelectionBucket[],
	eligibleProviderNames: ReadonlySet<string>,
): SelectionBucket[] {
	return buckets
		.map((bucket) => ({
			id: bucket.id,
			members: bucket.members.filter((providerName) => eligibleProviderNames.has(providerName)),
		}))
		.filter((bucket) => bucket.members.length > 0);
}

function quotaKindRank(kind: SelectionQuotaKind): number {
	switch (kind) {
		case "ready":
			return 0;
		case "watch":
			return 1;
		case "low":
			return 2;
		case "blocked":
			return 3;
		case "error":
			return 4;
		case "missing-auth":
			return 5;
	}
}

function isUsableQuotaResult(result: SelectionQuotaResult): boolean {
	return result.kind === "ready" || result.kind === "watch" || result.kind === "low";
}

export function planQuotaFirstSelection(
	buckets: SelectionBucket[],
	quotaByProvider: ReadonlyMap<string, SelectionQuotaResult>,
): QuotaSelectionPlan {
	for (const bucket of buckets) {
		const usable = bucket.members
			.map((providerName) => ({ providerName, result: quotaByProvider.get(providerName) }))
			.filter((candidate): candidate is { providerName: string; result: SelectionQuotaResult } =>
				candidate.result !== undefined && isUsableQuotaResult(candidate.result),
			)
			.sort((left, right) =>
				quotaKindRank(left.result.kind) - quotaKindRank(right.result.kind)
				|| right.result.score - left.result.score
				|| left.providerName.localeCompare(right.providerName),
			);
		if (usable[0]) return { kind: "selected", providerName: usable[0].providerName };

		const unknown = bucket.members.filter((providerName) => {
			const result = quotaByProvider.get(providerName);
			return result === undefined || result.kind === "error";
		});
		if (unknown.length > 0) {
			return { kind: "round-robin", bucketId: bucket.id, providerNames: unknown };
		}
	}
	return { kind: "unavailable" };
}
