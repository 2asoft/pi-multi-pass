/**
 * Multi-Subscription extension for pi.
 *
 * Register additional OAuth subscription accounts for any supported provider.
 * Each extra account gets its own provider name, /login entry, and cloned models.
 *
 * Features:
 *   - /subs: manage subscriptions (add, remove, login, logout, status)
 *   - /subs: manage equivalent subscription accounts and auto-switching
 *
 * Auto-switching: equivalent accounts for the same base provider can be
 * enabled for automatic failover on rate-limit-style runtime errors.
 *
 * Config file:
 *   Global: ~/.pi/agent/multi-pass.json
 *
 * Supported providers:
 *   - anthropic          (Claude Pro/Max)
 *   - openai-codex       (ChatGPT Plus/Pro Codex)
 *   - github-copilot     (GitHub Copilot)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	AgentEndEvent,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getAgentDir,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import {
	anthropicOAuthProvider,
	openaiCodexOAuthProvider,
	githubCopilotOAuthProvider,
	getGitHubCopilotBaseUrl,
	normalizeDomain,
	type OAuthCredentials,
	type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import {
	Container,
	Key,
	SelectList,
	Text,
	matchesKey,
	type SelectItem,
} from "@earendil-works/pi-tui";

// ==========================================================================
// Provider templates
// ==========================================================================

type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };

interface ProviderTemplate {
	displayName: string;
	builtinOAuth: OAuthProviderInterface;
	buildOAuth(index: number): Omit<OAuthProviderInterface, "id">;
	buildModifyModels?(providerName: string): OAuthProviderInterface["modifyModels"];
}

function buildEquivalentOAuth(
	builtinOAuth: OAuthProviderInterface,
	name: string,
): Omit<OAuthProviderInterface, "id"> {
	return {
		name,
		usesCallbackServer: builtinOAuth.usesCallbackServer,
		login(callbacks) {
			return builtinOAuth.login(callbacks);
		},
		refreshToken(credentials) {
			return builtinOAuth.refreshToken(credentials);
		},
		getApiKey(credentials) {
			return builtinOAuth.getApiKey(credentials);
		},
	};
}

const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		builtinOAuth: anthropicOAuthProvider,
		buildOAuth(index: number) {
			return buildEquivalentOAuth(anthropicOAuthProvider, `Anthropic #${index}`);
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		builtinOAuth: openaiCodexOAuthProvider,
		buildOAuth(index: number) {
			return buildEquivalentOAuth(openaiCodexOAuthProvider, `ChatGPT Codex #${index}`);
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		builtinOAuth: githubCopilotOAuthProvider,
		buildOAuth(index: number) {
			return buildEquivalentOAuth(githubCopilotOAuthProvider, `GitHub Copilot #${index}`);
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const domain = creds.enterpriseUrl
					? (normalizeDomain(creds.enterpriseUrl) ?? undefined)
					: undefined;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

};

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

// ==========================================================================
// Built-in quota checking
// ==========================================================================

const DEFAULT_CODEX_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

type QuotaStatusKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";

interface AuthStorageEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	projectId?: string;
	[key: string]: unknown;
}

interface QuotaAccount {
	providerName: string;
	baseProvider: string;
	displayName: string;
	auth?: AuthStorageEntry;
}

interface QuotaCheckResult {
	account: QuotaAccount;
	kind: QuotaStatusKind;
	summary: string;
	details: string[];
	score: number;
}

interface ProviderQuotaChecker {
	baseProvider: string;
	check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult>;
}

interface CodexUsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
}

interface CodexRateLimitState {
	allowed?: boolean;
	limitReached?: boolean;
}

interface CodexUsageSnapshot {
	planType: string;
	email: string;
	primary?: CodexUsageWindow;
	fiveHour?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
	rateLimit?: CodexRateLimitState;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function getCodexTokenMetadata(accessToken: string): {
	accountId?: string;
	planType?: string;
	email?: string;
} {
	const payload = decodeJwtPayload(accessToken);
	const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
	const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	const email = typeof profile?.email === "string" ? profile.email : undefined;
	return { accountId, planType, email };
}

function normalizeCodexUsageWindow(window: unknown): CodexUsageWindow | undefined {
	const raw = getRecord(window);
	if (!raw) return undefined;
	const usedPercent = typeof raw.used_percent === "number" ? raw.used_percent : 0;
	const windowSeconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : 0;
	const resetAt = typeof raw.reset_at === "number" ? raw.reset_at : undefined;
	return {
		usedPercent,
		windowSeconds,
		resetAt,
	};
}

function parseCodexRateLimitState(rateLimit: unknown): CodexRateLimitState | undefined {
	const raw = getRecord(rateLimit);
	if (!raw) return undefined;
	const allowed = typeof raw.allowed === "boolean" ? raw.allowed : undefined;
	const limitReached = typeof raw.limit_reached === "boolean" ? raw.limit_reached : undefined;
	if (allowed === undefined && limitReached === undefined) return undefined;
	return { allowed, limitReached };
}

function matchesUsageWindow(window: CodexUsageWindow | undefined, expectedSeconds: number): boolean {
	if (!window) return false;
	return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function parseCodexUsageSnapshot(data: unknown): CodexUsageSnapshot {
	const raw = getRecord(data);
	const rateLimit = getRecord(raw?.rate_limit);
	const windows = [
		normalizeCodexUsageWindow(rateLimit?.primary_window),
		normalizeCodexUsageWindow(rateLimit?.secondary_window),
	].filter((window): window is CodexUsageWindow => Boolean(window));
	const fiveHour = windows.find((window) => matchesUsageWindow(window, 5 * 60 * 60));
	const weekly = windows.find((window) => matchesUsageWindow(window, 7 * 24 * 60 * 60));
	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
		email: typeof raw?.email === "string" ? raw.email : "",
		primary: windows[0],
		fiveHour,
		weekly,
		rateLimit: parseCodexRateLimitState(rateLimit),
	};
}

function getCodexWindowRemaining(window: CodexUsageWindow | undefined): number | undefined {
	if (!window) return undefined;
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function formatResetShort(resetAt?: number): string {
	if (!resetAt) return "--";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `~${days}d`;
	if (hours > 0) return `~${hours}h`;
	return `~${minutes}m`;
}

function formatResetLong(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}

function formatRemainingPercent(value: number | undefined): string {
	if (value === undefined) return "--";
	return `${Math.round(value)}%`;
}

function formatCodexWindowSummary(label: string, window: CodexUsageWindow | undefined): string | undefined {
	const remaining = getCodexWindowRemaining(window);
	if (remaining === undefined) return undefined;
	return `${label} ${formatRemainingPercent(remaining)} (${formatResetShort(window?.resetAt)})`;
}

function formatCodexRateLimitState(state: CodexRateLimitState | undefined): string | undefined {
	if (!state) return undefined;
	const parts: string[] = [];
	if (state.allowed !== undefined) parts.push(`allowed=${state.allowed}`);
	if (state.limitReached !== undefined) parts.push(`limit_reached=${state.limitReached}`);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function parseIsoTimestampSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.floor(parsed / 1000);
}

async function readResponseError(response: Response): Promise<string> {
	const raw = await response.text();
	if (response.status === 401) {
		return "Unauthorized - log in again";
	}
	if (!raw) {
		return `HTTP ${response.status}`;
	}
	try {
		const parsed = JSON.parse(raw) as {
			error?: { message?: string };
			message?: string;
		};
		const message = parsed.error?.message || parsed.message;
		if (message) return `HTTP ${response.status}: ${message}`;
	} catch {
		// ignore JSON parse errors and fall back to raw text
	}
	return `HTTP ${response.status}: ${raw}`;
}

function classifyCodexQuotaKind(snapshot: CodexUsageSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
	const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
	const values = [fiveHourLeft, weeklyLeft].filter((value): value is number => value !== undefined);
	if (snapshot.rateLimit?.limitReached === true || snapshot.rateLimit?.allowed === false) {
		return { kind: "blocked", score: 0 };
	}
	if (values.length === 0) {
		const primaryLeft = getCodexWindowRemaining(snapshot.primary);
		if (primaryLeft !== undefined) values.push(primaryLeft);
	}
	if (values.length === 0) {
		if (snapshot.rateLimit?.allowed === true || snapshot.rateLimit?.limitReached === false) {
			return { kind: "ready", score: 100 };
		}
		return { kind: "error", score: 0 };
	}
	const bottleneck = Math.min(...values);
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

function formatQuotaKind(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "ready";
		case "watch":
			return "watch";
		case "low":
			return "low";
		case "blocked":
			return "blocked";
		case "missing-auth":
			return "not logged in";
		default:
			return "error";
	}
}

function compareQuotaResults(left: QuotaCheckResult, right: QuotaCheckResult): number {
	const rank = (kind: QuotaStatusKind): number => {
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
	};
	return rank(left.kind) - rank(right.kind)
		|| right.score - left.score
		|| left.account.displayName.localeCompare(right.account.displayName);
}

function getWrappedSelectIndex(items: SelectItem[], value: string | undefined): number {
	if (!value) return 0;
	const index = items.findIndex((item) => item.value === value);
	return index >= 0 ? index : 0;
}

async function showWrappedSelect(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		items: SelectItem[];
		subtitle?: string;
		initialValue?: string;
		confirmHint?: string;
		cancelHint?: string;
	},
): Promise<string | undefined> {
	if (options.items.length === 0) return undefined;

	if (!ctx.hasUI || ctx.mode !== "tui") {
		const renderedItems = options.items.map((item) =>
			item.description ? `${item.label} — ${item.description}` : item.label,
		);
		const selected = await ctx.ui.select(options.title, renderedItems);
		if (!selected) return undefined;
		const index = renderedItems.indexOf(selected);
		return index >= 0 ? options.items[index]?.value : undefined;
	}

	const confirmHint = options.confirmHint || "select";
	const cancelHint = options.cancelHint || "close";

	const selectedValue = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const footer = [
			keyHint("tui.select.confirm", confirmHint),
			keyHint("tui.select.cancel", cancelHint),
		].join(" • ");

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
		if (options.subtitle) {
			container.addChild(new Text(theme.fg("dim", options.subtitle)));
		}

		const selectList = new SelectList(options.items, Math.min(options.items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.setSelectedIndex(getWrappedSelectIndex(options.items, options.initialValue));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", footer)));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const current = selectList.getSelectedItem();
				const currentIndex = current
					? options.items.findIndex((item) => item.value === current.value)
					: 0;

				if (matchesKey(data, Key.up) && options.items.length > 1 && currentIndex === 0) {
					selectList.setSelectedIndex(options.items.length - 1);
					tui.requestRender();
					return;
				}

				if (
					matchesKey(data, Key.down)
					&& options.items.length > 1
					&& currentIndex === options.items.length - 1
				) {
					selectList.setSelectedIndex(0);
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedValue ?? undefined;
}

async function runQuotaChecks(
	accounts: QuotaAccount[],
	signal?: AbortSignal,
): Promise<QuotaCheckResult[]> {
	const results = await Promise.all(accounts.map(async (account) => {
		const checker = PROVIDER_QUOTA_CHECKERS.find(
			(candidate) => candidate.baseProvider === account.baseProvider,
		);
		if (!checker) return undefined;
		return checker.check(account, signal);
	}));

	return results
		.filter((result): result is QuotaCheckResult => Boolean(result))
		.sort(compareQuotaResults);
}

const codexQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "openai-codex",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		const auth = account.auth;
		if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
			return {
				account,
				kind: "missing-auth",
				summary: "not logged in",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: not logged in",
					"login: use /subs login or /login to authenticate this account",
				],
				score: 0,
			};
		}

		const tokenMetadata = getCodexTokenMetadata(auth.access);
		const accountId = typeof auth.accountId === "string" && auth.accountId.length > 0
			? auth.accountId
			: tokenMetadata.accountId;
		const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(/\/+$/, "");
		const headers = new Headers({
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
			"User-Agent": "pi-multi-pass",
		});
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}

		try {
			const response = await fetch(`${baseUrl}/wham/usage`, {
				method: "GET",
				headers,
				signal,
			});
			if (!response.ok) {
				const error = await readResponseError(response);
				return {
					account,
					kind: "error",
					summary: error,
					details: [
						`account: ${account.displayName}`,
						`provider: ${account.providerName}`,
						`status: error`,
						`details: ${error}`,
					],
					score: 0,
				};
			}

			const snapshot = parseCodexUsageSnapshot(await response.json());
			if (!snapshot.email && tokenMetadata.email) snapshot.email = tokenMetadata.email;
			if ((!snapshot.planType || snapshot.planType === "unknown") && tokenMetadata.planType) {
				snapshot.planType = tokenMetadata.planType;
			}
			const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
			const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
			const classification = classifyCodexQuotaKind(snapshot);
			const windowSummaries = [
				formatCodexWindowSummary("5h", snapshot.fiveHour),
				formatCodexWindowSummary("7d", snapshot.weekly),
			].filter((part): part is string => Boolean(part));
			if (windowSummaries.length === 0) {
				const primarySummary = formatCodexWindowSummary("primary", snapshot.primary);
				if (primarySummary) windowSummaries.push(primarySummary);
			}
			const summary = [
				snapshot.planType !== "unknown" ? snapshot.planType : "plan unknown",
				...(windowSummaries.length > 0 ? windowSummaries : ["quota windows unavailable"]),
				formatQuotaKind(classification.kind),
			].join(" | ");
			const details = [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				`status: ${formatQuotaKind(classification.kind)}`,
				`plan: ${snapshot.planType}`,
			];
			if (snapshot.email) {
				details.push(`email: ${snapshot.email}`);
			}
			const rateLimitState = formatCodexRateLimitState(snapshot.rateLimit);
			if (rateLimitState) {
				details.push(`rate limit state: ${rateLimitState}`);
			}
			if (!snapshot.fiveHour && !snapshot.weekly) {
				if (snapshot.primary) {
					details.push("quota windows: endpoint did not return named 5-hour or 7-day windows; showing primary window");
				} else if (rateLimitState) {
					details.push("quota windows: endpoint did not return quota windows; using rate limit state");
				}
			}
			if (snapshot.primary && !snapshot.fiveHour && !snapshot.weekly) {
				details.push(`primary window: ${formatRemainingPercent(getCodexWindowRemaining(snapshot.primary))} left, resets ${formatResetLong(snapshot.primary.resetAt)}`);
			} else {
				details.push(
					`5-hour window: ${formatRemainingPercent(fiveHourLeft)} left, resets ${formatResetLong(snapshot.fiveHour?.resetAt)}`,
					`7-day window: ${formatRemainingPercent(weeklyLeft)} left, resets ${formatResetLong(snapshot.weekly?.resetAt)}`,
				);
			}
			details.push(`endpoint: ${baseUrl}/wham/usage`);
			return {
				account,
				kind: classification.kind,
				summary,
				details,
				score: classification.score,
			};
		} catch (error: unknown) {
			if (signal?.aborted || isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return {
				account,
				kind: "error",
				summary: message,
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					`details: ${message}`,
				],
				score: 0,
			};
		}
	},
};

const PROVIDER_QUOTA_CHECKERS: ProviderQuotaChecker[] = [
	codexQuotaChecker,
];

async function showQuotaDetails(
	ctx: ExtensionCommandContext,
	result: QuotaCheckResult,
): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Limit Details: ${result.account.displayName}`,
		subtitle: "Press Enter or Escape to go back to the limits list.",
		items: result.details.map((detail, index) => ({ value: `${index}:${detail}`, label: detail })),
		confirmHint: "back",
		cancelHint: "back",
	});
}



// ==========================================================================
// Equivalent sets config
// ==========================================================================

type AutoSwitchStrategy = "quota-first" | "round-robin" | "manual";

interface EquivalentMember {
	providerName: string;
	label?: string;
	enabled: boolean;
}

interface AutoSwitchPolicy {
	enabled: boolean;
	strategy: AutoSwitchStrategy;
	cooldownMs: number;
}

interface EquivalentSet {
	id: string;
	baseProvider: string;
	members: EquivalentMember[];
	autoSwitch: AutoSwitchPolicy;
}

interface MultiPassConfig {
	sets: EquivalentSet[];
}

interface RuntimeMemberState {
	exhaustedUntil?: number;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

function globalConfigPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function emptyMultiPassConfig(): MultiPassConfig {
	return { sets: [] };
}

function defaultSetId(baseProvider: string): string {
	return baseProvider
		.replace(/^openai-/, "")
		.replace(/-cli$/, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function normalizeAutoSwitchPolicy(value: unknown): AutoSwitchPolicy {
	const raw = getRecord(value);
	const strategy = raw?.strategy === "round-robin" || raw?.strategy === "manual" || raw?.strategy === "quota-first"
		? raw.strategy
		: "quota-first";
	const cooldownMs = typeof raw?.cooldownMs === "number" && Number.isFinite(raw.cooldownMs) && raw.cooldownMs >= 0
		? Math.round(raw.cooldownMs)
		: DEFAULT_COOLDOWN_MS;
	return {
		enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
		strategy,
		cooldownMs,
	};
}

function normalizeMember(value: unknown): EquivalentMember | undefined {
	const raw = getRecord(value);
	if (!raw || typeof raw.providerName !== "string" || raw.providerName.trim().length === 0) return undefined;
	const member: EquivalentMember = {
		providerName: raw.providerName.trim(),
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
	};
	if (typeof raw.label === "string" && raw.label.trim().length > 0) member.label = raw.label.trim();
	return member;
}

function normalizeSet(value: unknown): EquivalentSet | undefined {
	const raw = getRecord(value);
	if (!raw || typeof raw.baseProvider !== "string" || !PROVIDER_TEMPLATES[raw.baseProvider]) return undefined;
	const baseProvider = raw.baseProvider;
	const members = (Array.isArray(raw.members) ? raw.members : [])
		.map(normalizeMember)
		.filter((member): member is EquivalentMember => Boolean(member));
	if (!members.some((member) => member.providerName === baseProvider)) {
		members.unshift({ providerName: baseProvider, enabled: true });
	}
	const seen = new Set<string>();
	const uniqueMembers = members.filter((member) => {
		if (seen.has(member.providerName)) return false;
		if (getBaseProvider(member.providerName) !== baseProvider) return false;
		seen.add(member.providerName);
		return true;
	});
	return {
		id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : defaultSetId(baseProvider),
		baseProvider,
		members: uniqueMembers,
		autoSwitch: normalizeAutoSwitchPolicy(raw.autoSwitch),
	};
}

function normalizeMultiPassConfig(raw: unknown): MultiPassConfig {
	const record = getRecord(raw);
	const sets = (Array.isArray(record?.sets) ? record.sets : [])
		.map(normalizeSet)
		.filter((set): set is EquivalentSet => Boolean(set));
	return { sets };
}

function loadGlobalConfig(): MultiPassConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return emptyMultiPassConfig();
	try {
		return normalizeMultiPassConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return emptyMultiPassConfig();
	}
}

function saveGlobalConfig(config: MultiPassConfig): void {
	const path = globalConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(normalizeMultiPassConfig(config), null, 2));
}

function getBaseProvider(providerName: string): string | undefined {
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

function memberIndex(providerName: string, baseProvider: string): number | undefined {
	if (providerName === baseProvider) return 1;
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (!match || match[1] !== baseProvider) return undefined;
	const parsed = Number.parseInt(match[2], 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function nextProviderName(set: EquivalentSet): string {
	const used = new Set<number>();
	for (const member of set.members) {
		const index = memberIndex(member.providerName, set.baseProvider);
		if (index !== undefined) used.add(index);
	}
	let next = 2;
	while (used.has(next)) next++;
	return `${set.baseProvider}-${next}`;
}

function ensureSet(config: MultiPassConfig, baseProvider: string): EquivalentSet {
	const existing = config.sets.find((set) => set.baseProvider === baseProvider);
	if (existing) return existing;
	const created: EquivalentSet = {
		id: defaultSetId(baseProvider),
		baseProvider,
		members: [{ providerName: baseProvider, enabled: true }],
		autoSwitch: { enabled: true, strategy: "quota-first", cooldownMs: DEFAULT_COOLDOWN_MS },
	};
	config.sets.push(created);
	return created;
}

function findSetForProvider(config: MultiPassConfig, providerName: string): EquivalentSet | undefined {
	return config.sets.find((set) => set.members.some((member) => member.providerName === providerName));
}

function memberDisplayName(member: EquivalentMember, set?: EquivalentSet): string {
	const baseProvider = set?.baseProvider || getBaseProvider(member.providerName) || member.providerName;
	const template = PROVIDER_TEMPLATES[baseProvider];
	const nativeSuffix = member.providerName === baseProvider ? "native" : member.providerName;
	const label = member.label ? `${member.label} - ` : "";
	return `${label}${template?.displayName || baseProvider} (${nativeSuffix})`;
}

function formatMemberLine(member: EquivalentMember, set: EquivalentSet, authStorage: { hasAuth(provider: string): boolean }): string {
	const auth = authStorage.hasAuth(member.providerName) ? "logged in" : "not logged in";
	const auto = member.enabled ? "auto" : "manual only";
	return `${member.providerName} -- ${memberDisplayName(member, set)} | ${auto} | ${auth}`;
}

function allMembers(config: MultiPassConfig): Array<{ set: EquivalentSet; member: EquivalentMember }> {
	return config.sets.flatMap((set) => set.members.map((member) => ({ set, member })));
}

// ==========================================================================
// Provider registration and model helpers
// ==========================================================================

function cloneModels(originalProvider: string, index: number): ProviderModelConfig[] {
	const models = getModels(originalProvider as never) as Model<Api>[];
	return models.map((model) => ({
		id: model.id,
		name: `${model.name} (#${index})`,
		api: model.api,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: model.input as ("text" | "image")[],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers ? { ...model.headers } : undefined,
		compat: model.compat,
	}));
}

function registerEquivalentProvider(pi: ExtensionAPI, providerName: string): void {
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider || baseProvider === providerName) return;
	const index = memberIndex(providerName, baseProvider);
	if (!index || index < 2) return;
	const template = PROVIDER_TEMPLATES[baseProvider];
	if (!template) return;
	const oauth = template.buildOAuth(index);
	const modifyModels = template.buildModifyModels?.(providerName);
	const builtinModels = getModels(baseProvider as never) as Model<Api>[];
	pi.registerProvider(providerName, {
		baseUrl: builtinModels[0]?.baseUrl || "",
		api: builtinModels[0]?.api,
		oauth: modifyModels ? { ...oauth, modifyModels } : oauth,
		models: cloneModels(baseProvider, index),
	});
}

function registerConfiguredProviders(pi: ExtensionAPI, config: MultiPassConfig): void {
	for (const { member } of allMembers(config)) {
		registerEquivalentProvider(pi, member.providerName);
	}
}

function findProviderModel(ctx: ExtensionContext | ExtensionCommandContext, providerName: string, preferredModelId?: string): Model<Api> | undefined {
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) return preferred as Model<Api>;
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) return undefined;
	for (const baseModel of getModels(baseProvider as never) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) return candidate as Model<Api>;
	}
	return undefined;
}

// ==========================================================================
// Quota account collection and limits UI
// ==========================================================================

function collectQuotaAccounts(ctx: ExtensionContext | ExtensionCommandContext, config = loadGlobalConfig()): QuotaAccount[] {
	const seen = new Set<string>();
	const accounts: QuotaAccount[] = [];
	for (const { set, member } of allMembers(config)) {
		if (!PROVIDER_QUOTA_CHECKERS.some((checker) => checker.baseProvider === set.baseProvider)) continue;
		if (seen.has(member.providerName)) continue;
		seen.add(member.providerName);
		accounts.push({
			providerName: member.providerName,
			baseProvider: set.baseProvider,
			displayName: memberDisplayName(member, set),
			auth: ctx.modelRegistry.authStorage.get(member.providerName) as AuthStorageEntry | undefined,
		});
	}
	return accounts;
}

// ==========================================================================
// Auto-switch engine
// ==========================================================================

const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i,
	/rate.?limit/i,
	/limit.*reached/i,
	/too many requests/i,
	/overloaded/i,
	/capacity/i,
	/429/,
	/quota/i,
];

function isRateLimitError(errorMessage: string): boolean {
	return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

class EquivalentSetRuntime {
	private readonly memberState = new Map<string, RuntimeMemberState>();
	private readonly roundRobinIndex = new Map<string, number>();
	private lastPrompt: string | null = null;
	private suppressNextPrompt = false;

	constructor(private readonly pi: ExtensionAPI) {}

	startTurn(prompt: string): void {
		if (this.suppressNextPrompt) {
			this.suppressNextPrompt = false;
			return;
		}
		this.lastPrompt = prompt;
	}

	markExhausted(providerName: string, cooldownMs: number): void {
		this.memberState.set(providerName, { exhaustedUntil: Date.now() + cooldownMs });
	}

	isExhausted(providerName: string): boolean {
		const until = this.memberState.get(providerName)?.exhaustedUntil;
		if (!until) return false;
		if (until <= Date.now()) {
			this.memberState.delete(providerName);
			return false;
		}
		return true;
	}

	availableMembers(set: EquivalentSet, authStorage: { hasAuth(provider: string): boolean }): EquivalentMember[] {
		return set.members.filter((member) =>
			member.enabled && authStorage.hasAuth(member.providerName) && !this.isExhausted(member.providerName),
		);
	}

	private chooseRoundRobin(set: EquivalentSet, currentProvider: string, authStorage: { hasAuth(provider: string): boolean }): EquivalentMember | undefined {
		const members = this.availableMembers(set, authStorage).filter((member) => member.providerName !== currentProvider);
		if (members.length === 0) return undefined;
		const cursor = this.roundRobinIndex.get(set.id) || 0;
		for (let offset = 0; offset < members.length; offset++) {
			const member = members[(cursor + offset) % members.length];
			this.roundRobinIndex.set(set.id, (cursor + offset + 1) % members.length);
			return member;
		}
		return undefined;
	}

	private async chooseQuotaFirst(
		set: EquivalentSet,
		currentProvider: string,
		ctx: ExtensionContext,
	): Promise<EquivalentMember | undefined> {
		const candidates = this.availableMembers(set, ctx.modelRegistry.authStorage)
			.filter((member) => member.providerName !== currentProvider);
		if (candidates.length === 0) return undefined;
		const accounts = candidates.map((member) => ({
			providerName: member.providerName,
			baseProvider: set.baseProvider,
			displayName: memberDisplayName(member, set),
			auth: ctx.modelRegistry.authStorage.get(member.providerName) as AuthStorageEntry | undefined,
		}));
		const results = await runQuotaChecks(accounts);
		const bestReady = results.find((result) => result.kind !== "error" && result.kind !== "missing-auth");
		if (bestReady) {
			return candidates.find((member) => member.providerName === bestReady.account.providerName);
		}
		return this.chooseRoundRobin(set, currentProvider, ctx.modelRegistry.authStorage);
	}

	private async chooseNext(set: EquivalentSet, currentProvider: string, ctx: ExtensionContext): Promise<EquivalentMember | undefined> {
		if (set.autoSwitch.strategy === "manual") return undefined;
		if (set.autoSwitch.strategy === "quota-first") {
			return this.chooseQuotaFirst(set, currentProvider, ctx);
		}
		return this.chooseRoundRobin(set, currentProvider, ctx.modelRegistry.authStorage);
	}

	async handleRateLimit(errorMessage: string, currentModel: Model<Api> | undefined, ctx: ExtensionContext): Promise<boolean> {
		if (!currentModel || !isRateLimitError(errorMessage)) return false;
		const config = loadGlobalConfig();
		const set = findSetForProvider(config, currentModel.provider);
		if (!set || !set.autoSwitch.enabled) return false;

		this.markExhausted(currentModel.provider, set.autoSwitch.cooldownMs);
		const next = await this.chooseNext(set, currentModel.provider, ctx);
		if (!next) {
			ctx.ui.notify(`[subs:${set.id}] no enabled authenticated equivalent account available for auto-switch`, "warning");
			ctx.ui.setStatus("multi-pass", `${set.id}: exhausted`);
			return false;
		}

		const nextModel = ctx.modelRegistry.find(next.providerName, currentModel.id);
		if (!nextModel) {
			ctx.ui.notify(`[subs:${set.id}] ${next.providerName} cannot serve model ${currentModel.id}`, "warning");
			return false;
		}

		const success = await this.pi.setModel(nextModel);
		if (!success) {
			ctx.ui.notify(`[subs:${set.id}] failed to switch to ${next.providerName}`, "warning");
			return false;
		}

		ctx.ui.notify(`[subs:${set.id}] rate limited on ${currentModel.provider}; switched to ${next.providerName}`, "info");
		ctx.ui.setStatus("multi-pass", `${set.id} via ${next.providerName}`);
		if (this.lastPrompt) {
			this.suppressNextPrompt = true;
			this.pi.sendUserMessage(this.lastPrompt);
		}
		return true;
	}
}

// ==========================================================================
// /subs commands
// ==========================================================================

function supportedProviderItems(): SelectItem[] {
	return SUPPORTED_PROVIDERS.map((provider) => ({
		value: provider,
		label: PROVIDER_TEMPLATES[provider]?.displayName || provider,
		description: provider,
	}));
}

async function selectBaseProvider(ctx: ExtensionCommandContext, preferred?: string): Promise<string | undefined> {
	if (preferred && PROVIDER_TEMPLATES[preferred]) return preferred;
	return showWrappedSelect(ctx, {
		title: "Add Equivalent Subscription",
		subtitle: "Pick the subscription type to add another equivalent account for.",
		items: supportedProviderItems(),
		confirmHint: "add",
		cancelHint: "cancel",
	});
}

async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, requestedProvider?: string): Promise<void> {
	const baseProvider = await selectBaseProvider(ctx, requestedProvider);
	if (!baseProvider) return;
	const config = loadGlobalConfig();
	const set = ensureSet(config, baseProvider);
	const providerName = nextProviderName(set);
	const label = await ctx.ui.input("Account label", "optional, e.g. work");
	const member: EquivalentMember = { providerName, enabled: true };
	if (label?.trim()) member.label = label.trim();
	set.members.push(member);
	set.autoSwitch.enabled = true;
	if (!set.autoSwitch.strategy) set.autoSwitch.strategy = "quota-first";
	saveGlobalConfig(config);
	registerEquivalentProvider(pi, providerName);
	ctx.ui.notify(`Added ${providerName}. Use /login and select ${PROVIDER_TEMPLATES[baseProvider]?.buildOAuth(memberIndex(providerName, baseProvider) || 2).name}.`, "info");
}

interface DashboardMemberState {
	set: EquivalentSet;
	member: EquivalentMember;
	authed: boolean;
	current: boolean;
	quota?: QuotaCheckResult;
}

interface DashboardState {
	config: MultiPassConfig;
	members: DashboardMemberState[];
}

async function buildDashboardState(ctx: ExtensionCommandContext): Promise<DashboardState> {
	const config = loadGlobalConfig();
	const results = await runQuotaChecks(collectQuotaAccounts(ctx, config));
	const quotaByProvider = new Map(results.map((result) => [result.account.providerName, result]));
	return {
		config,
		members: allMembers(config).map(({ set, member }) => ({
			set,
			member,
			authed: ctx.modelRegistry.authStorage.hasAuth(member.providerName),
			current: ctx.model?.provider === member.providerName,
			quota: quotaByProvider.get(member.providerName),
		})),
	};
}

function formatDashboardSetDescription(set: EquivalentSet, states: DashboardMemberState[]): string {
	const authed = states.filter((state) => state.authed).length;
	const auto = states.filter((state) => state.member.enabled).length;
	return `auto-switch ${set.autoSwitch.enabled ? "on" : "off"} | ${set.autoSwitch.strategy} | ${auto}/${states.length} auto | ${authed}/${states.length} logged in`;
}

function formatDashboardMemberDescription(state: DashboardMemberState): string {
	const parts = [
		state.member.enabled ? "auto" : "manual",
		state.authed ? "logged in" : "not logged in",
	];
	if (state.current) parts.push("current");
	if (state.quota) parts.push(state.quota.summary);
	return parts.join(" | ");
}

function dashboardItems(state: DashboardState): SelectItem[] {
	const items: SelectItem[] = [
		{ value: "action:add", label: "add account", description: "Add another equivalent account" },
	];
	for (const set of state.config.sets) {
		const states = state.members.filter((candidate) => candidate.set.id === set.id);
		items.push({
			value: `set:${set.id}`,
			label: `${set.id} -- ${PROVIDER_TEMPLATES[set.baseProvider]?.displayName || set.baseProvider}`,
			description: formatDashboardSetDescription(set, states),
		});
		for (const memberState of states) {
			items.push({
				value: `member:${memberState.member.providerName}`,
				label: `  ${memberState.member.enabled ? "[auto]" : "[manual]"} ${memberState.member.providerName}`,
				description: formatDashboardMemberDescription(memberState),
			});
		}
	}
	return items;
}

function loginInstructionForMember(set: EquivalentSet, member: EquivalentMember): string {
	const index = memberIndex(member.providerName, set.baseProvider);
	return member.providerName === set.baseProvider
		? PROVIDER_TEMPLATES[set.baseProvider]?.builtinOAuth.name || set.baseProvider
		: PROVIDER_TEMPLATES[set.baseProvider]?.buildOAuth(index || 2).name || member.providerName;
}

async function switchToProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerName: string): Promise<void> {
	const model = findProviderModel(ctx, providerName, ctx.model?.id);
	if (!model) {
		ctx.ui.notify(`${providerName} cannot serve current model ${ctx.model?.id || "unknown"}.`, "warning");
		return;
	}
	const success = await pi.setModel(model);
	ctx.ui.notify(success ? `Switched to ${providerName}/${model.id}.` : `Failed to switch to ${providerName}.`, success ? "info" : "warning");
}

async function handleDashboardSetActions(ctx: ExtensionCommandContext, config: MultiPassConfig, set: EquivalentSet): Promise<void> {
	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: `Set: ${set.id}`,
			subtitle: formatDashboardSetDescription(set, set.members.map((member) => ({ set, member, authed: ctx.modelRegistry.authStorage.hasAuth(member.providerName), current: ctx.model?.provider === member.providerName }))),
			items: [
				{ value: "toggle-auto", label: "toggle auto-switch", description: `currently ${set.autoSwitch.enabled ? "on" : "off"}` },
				{ value: "strategy-quota-first", label: "strategy: quota-first", description: "prefer account with most quota" },
				{ value: "strategy-round-robin", label: "strategy: round-robin", description: "rotate through auto accounts" },
				{ value: "strategy-manual", label: "strategy: manual", description: "do not auto-switch" },
			],
			confirmHint: "apply",
			cancelHint: "back",
		});
		if (!action) return;
		if (action === "toggle-auto") set.autoSwitch.enabled = !set.autoSwitch.enabled;
		else if (action === "strategy-quota-first") set.autoSwitch.strategy = "quota-first";
		else if (action === "strategy-round-robin") set.autoSwitch.strategy = "round-robin";
		else if (action === "strategy-manual") set.autoSwitch.strategy = "manual";
		saveGlobalConfig(config);
	}
}

async function handleDashboardMemberActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	state: DashboardMemberState,
): Promise<void> {
	const { set, member, quota } = state;
	const actions: SelectItem[] = [
		{ value: "switch", label: "switch now", description: "Use this account for the current model" },
		{ value: "toggle-auto", label: member.enabled ? "make manual only" : "enable for auto-switch", description: "Toggle whether rate-limit failover may select this account" },
		{ value: "login", label: "login instructions", description: `Select ${loginInstructionForMember(set, member)} from /login` },
		{ value: "logout", label: "logout", description: state.authed ? "Clear saved auth for this account" : "Not logged in" },
	];
	if (quota) actions.push({ value: "quota", label: "quota details", description: quota.summary });
	if (member.providerName !== set.baseProvider) actions.push({ value: "remove", label: "remove", description: "Remove this equivalent account" });

	const action = await showWrappedSelect(ctx, {
		title: member.providerName,
		subtitle: memberDisplayName(member, set),
		items: actions,
		confirmHint: "run",
		cancelHint: "back",
	});
	if (!action) return;
	if (action === "switch") return switchToProvider(pi, ctx, member.providerName);
	if (action === "toggle-auto") {
		member.enabled = !member.enabled;
		saveGlobalConfig(config);
		ctx.ui.notify(`${member.providerName} is now ${member.enabled ? "enabled for auto-switch" : "manual only"}.`, "info");
		return;
	}
	if (action === "login") {
		ctx.ui.notify(`Use /login and select "${loginInstructionForMember(set, member)}".`, "info");
		return;
	}
	if (action === "logout") {
		ctx.modelRegistry.authStorage.logout(member.providerName);
		ctx.ui.notify(`Logged out ${member.providerName}.`, "info");
		return;
	}
	if (action === "quota" && quota) return showQuotaDetails(ctx, quota);
	if (action === "remove") {
		const confirmed = await ctx.ui.confirm("Remove account", `Remove ${member.providerName}? Auth for this account will also be cleared.`);
		if (!confirmed) return;
		set.members = set.members.filter((candidate) => candidate.providerName !== member.providerName);
		ctx.modelRegistry.authStorage.logout(member.providerName);
		pi.unregisterProvider(member.providerName);
		saveGlobalConfig(config);
		ctx.ui.notify(`Removed ${member.providerName}.`, "info");
	}
}

async function handleSubsDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const state = await buildDashboardState(ctx);
		if (state.config.sets.length === 0) {
			const action = await showWrappedSelect(ctx, {
				title: "Subscription Dashboard",
				subtitle: "No equivalent subscriptions configured.",
				items: [{ value: "action:add", label: "add account", description: "Add an equivalent subscription account" }],
				confirmHint: "open",
			});
			if (action === "action:add") await handleSubsAdd(pi, ctx);
			return;
		}
		const selected = await showWrappedSelect(ctx, {
			title: "Subscription Dashboard",
			subtitle: "Quota refreshed. Select an account or set for actions.",
			items: dashboardItems(state),
			initialValue: ctx.model?.provider ? `member:${ctx.model.provider}` : undefined,
			confirmHint: "actions",
			cancelHint: "close",
		});
		if (!selected) return;
		if (selected === "action:add") {
			await handleSubsAdd(pi, ctx);
			continue;
		}
		if (selected.startsWith("set:")) {
			const set = state.config.sets.find((candidate) => candidate.id === selected.slice("set:".length));
			if (set) await handleDashboardSetActions(ctx, state.config, set);
			continue;
		}
		if (selected.startsWith("member:")) {
			const providerName = selected.slice("member:".length);
			const memberState = state.members.find((candidate) => candidate.member.providerName === providerName);
			if (memberState) await handleDashboardMemberActions(pi, ctx, state.config, memberState);
		}
	}
}

async function selectConfiguredMember(
	ctx: ExtensionCommandContext,
	title: string,
	predicate: (set: EquivalentSet, member: EquivalentMember) => boolean = () => true,
): Promise<{ config: MultiPassConfig; set: EquivalentSet; member: EquivalentMember } | undefined> {
	const config = loadGlobalConfig();
	const entries = allMembers(config).filter(({ set, member }) => predicate(set, member));
	if (entries.length === 0) {
		ctx.ui.notify("No matching equivalent accounts.", "info");
		return undefined;
	}
	const selected = await showWrappedSelect(ctx, {
		title,
		items: entries.map(({ set, member }) => ({
			value: member.providerName,
			label: member.providerName,
			description: formatMemberLine(member, set, ctx.modelRegistry.authStorage),
		})),
	});
	if (!selected) return undefined;
	const entry = entries.find(({ member }) => member.providerName === selected);
	return entry ? { config, ...entry } : undefined;
}

async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const selected = await selectConfiguredMember(ctx, "Login Equivalent Subscription", (_set, member) => !ctx.modelRegistry.authStorage.hasAuth(member.providerName));
	if (!selected) return;
	const baseProvider = selected.set.baseProvider;
	const index = memberIndex(selected.member.providerName, baseProvider);
	const name = selected.member.providerName === baseProvider
		? PROVIDER_TEMPLATES[baseProvider]?.builtinOAuth.name || baseProvider
		: PROVIDER_TEMPLATES[baseProvider]?.buildOAuth(index || 2).name || selected.member.providerName;
	ctx.ui.notify(`Use /login and select "${name}".`, "info");
}

async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const selected = await selectConfiguredMember(ctx, "Logout Equivalent Subscription", (_set, member) => ctx.modelRegistry.authStorage.hasAuth(member.providerName));
	if (!selected) return;
	ctx.modelRegistry.authStorage.logout(selected.member.providerName);
	ctx.ui.notify(`Logged out ${selected.member.providerName}.`, "info");
}

async function handleSubsRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const selected = await selectConfiguredMember(ctx, "Remove Equivalent Subscription", (_set, member) => member.providerName !== _set.baseProvider);
	if (!selected) return;
	const confirmed = await ctx.ui.confirm("Remove account", `Remove ${selected.member.providerName}? Auth for this account will also be cleared.`);
	if (!confirmed) return;
	selected.set.members = selected.set.members.filter((member) => member.providerName !== selected.member.providerName);
	ctx.modelRegistry.authStorage.logout(selected.member.providerName);
	pi.unregisterProvider(selected.member.providerName);
	saveGlobalConfig(selected.config);
	ctx.ui.notify(`Removed ${selected.member.providerName}.`, "info");
}

async function handleSubsSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, requestedProvider?: string): Promise<void> {
	const config = loadGlobalConfig();
	let providerName = requestedProvider?.trim();
	if (!providerName) {
		const entries = allMembers(config).filter(({ member }) => ctx.modelRegistry.authStorage.hasAuth(member.providerName));
		if (entries.length === 0) {
			ctx.ui.notify("No logged-in equivalent accounts available.", "info");
			return;
		}
		providerName = await showWrappedSelect(ctx, {
			title: "Switch Equivalent Subscription",
			items: entries.map(({ set, member }) => ({
				value: member.providerName,
				label: member.providerName,
				description: formatMemberLine(member, set, ctx.modelRegistry.authStorage),
			})),
			initialValue: ctx.model?.provider,
			confirmHint: "switch",
		});
	}
	if (!providerName) return;
	const model = findProviderModel(ctx, providerName, ctx.model?.id);
	if (!model) {
		ctx.ui.notify(`${providerName} cannot serve current model ${ctx.model?.id || "unknown"}.`, "warning");
		return;
	}
	const success = await pi.setModel(model);
	ctx.ui.notify(success ? `Switched to ${providerName}/${model.id}.` : `Failed to switch to ${providerName}.`, success ? "info" : "warning");
}


async function dispatchSubsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, command: string, rest: string): Promise<void> {
	switch (command) {
		case "":
			return handleSubsDashboard(pi, ctx);
		case "add":
			return handleSubsAdd(pi, ctx, rest || undefined);
		case "login":
			return handleSubsLogin(ctx);
		case "logout":
			return handleSubsLogout(ctx);
		case "remove":
			return handleSubsRemove(pi, ctx);
		case "switch":
			return handleSubsSwitch(pi, ctx, rest || undefined);
		default:
			ctx.ui.notify(`Unknown /subs command: ${command}`, "warning");
			return;
	}
}

// ==========================================================================
// Extension entry point
// ==========================================================================

export default function multiSub(pi: ExtensionAPI) {
	const runtime = new EquivalentSetRuntime(pi);
	registerConfiguredProviders(pi, loadGlobalConfig());

	pi.on("session_start", async (_event, ctx) => {
		const config = loadGlobalConfig();
		const enabled = config.sets.filter((set) => set.autoSwitch.enabled);
		if (enabled.length > 0) {
			ctx.ui.setStatus("multi-pass", enabled.map((set) => `${set.id}:${set.autoSwitch.strategy}`).join(" | "));
		}
	});

	pi.on("before_agent_start", async (event) => {
		runtime.startTurn(event.prompt);
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		if (!event.messages || event.messages.length === 0) return;
		const lastMessage = event.messages[event.messages.length - 1];
		if (!lastMessage || lastMessage.role !== "assistant") return;
		const assistant = getRecord(lastMessage);
		if (assistant?.stopReason !== "error") return;
		const errorMessage = typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined;
		if (!errorMessage) return;
		await runtime.handleRateLimit(errorMessage, ctx.model, ctx);
	});

	pi.registerCommand("subs", {
		description: "Manage equivalent OAuth subscriptions",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["add", "remove", "login", "logout", "switch"];
			const filtered = subcommands.filter((subcommand) => subcommand.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((subcommand) => ({ value: subcommand, label: subcommand })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const command = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			return dispatchSubsCommand(pi, ctx, command, rest);
		},
	});
}
