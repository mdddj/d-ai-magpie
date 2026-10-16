// D.AI (dai.itbug.shop) as a magpie / OpenCode provider plugin.
//
// One D.AI API key (`ddsk_…`) signs an account in; magpie may hold several
// under the same provider. Models come from D.AI's public capability catalog
// (`GET /api/system/public/capability-docs`), narrowed to what the key may
// actually call (`GET /v1/models`). Chat models run on D.AI's
// OpenAI-compatible `/v1/chat/completions`, Claude models on `/v1/messages`.
// `auth.usage` reads the account behind the key (`GET /api/ai/account`): the
// wallet balance, the tier, and how much this key alone may spend.
//
// `auth.usage` reads `GET /api/ai/account`, a `ddsk_`-authenticated endpoint
// added for exactly this: the wallet balance, the tier, and what the key has
// used. The older JWT-only endpoints (`/api/usd/me`, `/api/user/usage-stats`)
// cannot serve a plugin, and the key's call log only counts calls, not money.
//
// Facts the tables below encode (checked 2026-10-15):
//   - The capability codes carrying token-metered chat are
//     `openai_chat_completions` (10 models) and `claude_messages` (5 models).
//   - `/v1/models` takes the API key as `Authorization: Bearer` or `x-api-key`
//     and lists only the models that key may use.
//   - `prepay_completion_token_limit` is D.AI's completion cap and the value a
//     client should send as its max output tokens (`sdks/pi/src/discover.ts`).
//   - Thinking levels and image input mirror `sdks/pi/src/thinking.ts`, the
//     only place these were verified against the upstreams behind D.AI. A model
//     absent from both tables is declared text-only without thinking levels
//     until someone checks it. D.AI's own catalog is not consulted for either:
//     it carries no per-model reasoning or modality metadata.
//
// Sections: constants · helpers · catalog · plugin.

const PROVIDER = "dai";
const DEFAULT_BASE = "https://dai.itbug.shop";
const OPENAI_NPM = "@ai-sdk/openai-compatible";
const ANTHROPIC_NPM = "@ai-sdk/anthropic";
const CATALOG_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

/** Capability codes whose models are token-metered chat models. */
const CHAT_CAPABILITIES = new Set(["openai_chat_completions", "claude_messages"]);

/** Thinking levels per model, verified against pi's tables. Absent = none offered. */
const VARIANTS = {
	// GPT-5.6: `off` is `none`, no `minimal`; the upstream takes the rest.
	"gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	// GPT-6 cannot turn thinking off.
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
	"gpt-6-sol": ["low", "medium", "high", "xhigh", "max"],
	// River rejects minimal, medium and xhigh on DeepSeek-V4.1-Flash; `none` is off.
	"deepseek-v4.1-flash": ["none", "low", "high", "max"],
	// GLM-5.3-Flash cannot disable reasoning; River also rejects minimal/medium/xhigh.
	"glm-5.3-flash": ["low", "high", "max"],
	// Claude: the adaptive-effort models take xhigh/max, Opus 5.5 the full range.
	"claude-fable-5": ["xhigh", "max"],
	"claude-opus-4-7": ["xhigh", "max"],
	"claude-opus-4-8": ["xhigh", "max"],
	"claude-opus-5": ["xhigh", "max"],
	"claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
};

/**
 * Models that take images as well as text, same set pi's tables mark.
 * Gemini, Grok and GPT-5.6 each carry `cache_write_usd_per_1m_tokens: null`
 * on D.AI today, so a null there reads as "no cache write price", not as a
 * missing check: only listed, non-zero rates become a model's cache price.
 */
const VISION = /^(?:gpt-5|gpt-6|deepseek-|glm-|claude-)/u;

/**
 * Offline fallback, in the shape the network path builds, for a magpie that
 * cannot reach D.AI while the provider is first configured.
 * `[id, context, output, input USD/1M, output USD/1M, cache-read USD/1M]`.
 */
const FALLBACK_ROWS = [
	["deepseek-v4.1-flash", 1_048_576, 128_000, 0.15, 0.6, 0.003],
	["gemini-3.8-flash", 1_050_000, 128_000, 0.5, 3, 0.05],
	["glm-5.3-flash", 1_048_576, 128_000, 0.15, 0.5, 0.03],
	["gpt-5.6-luna", 1_050_000, 128_000, 0.2, 1.2, 0.02],
	["gpt-5.6-sol", 1_050_000, 128_000, 5, 30, 0.5],
	["gpt-5.6-terra", 1_050_000, 128_000, 2, 12, 0.2],
	["gpt-6-astra", 1_050_000, 128_000, 10, 50, 1],
	["gpt-6-sol", 1_050_000, 128_000, 2, 10, 0.2],
	["grok-4.6", 500_000, 128_000, 1.5, 5, 0.4],
	["grok-4.7", 500_000, 128_000, 1.5, 5, 0.4],
	["claude-fable-5", 1_000_000, 128_000, 20, 100, 2],
	["claude-opus-4-7", 1_000_000, 128_000, 10, 50, 1],
	["claude-opus-4-8", 1_000_000, 128_000, 10, 50, 1],
	["claude-opus-5", 1_000_000, 128_000, 10, 50, 1],
	["claude-opus-5-5", 1_000_000, 128_000, 8, 40, 0.4],
];

// ---- helpers -------------------------------------------------------------------

const textOf = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");
const numberOr = (value, fallback) =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;
const optionalNumber = (value) =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const positiveNumber = (value) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * A USD amount as magpie's cards say one: whole dollars plain, otherwise the
 * significant decimals without a trail of zeros ($86.952653 -> "86.952653").
 * Six places is D.AI's scale, so nothing is rounded away that matters.
 */
function usd(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return "0";
	return n.toFixed(6).replace(/\.?0+$/u, "") || "0";
}

/** The base URL with no trailing slash and no trailing `/v1`. */
function normalizeBase(raw) {
	const value = textOf(raw);
	if (!value) return undefined;
	return value.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

const apiBase = (base) => `${base}/v1`;

const isClaudeModel = (id) => id.startsWith("claude-");

/** `ddsk_01ABC_secret` → what a card may show, never the secret itself. */
function keyLabel(key) {
	const id = textOf(key).replace(/^ddsk_/u, "").split("_")[0];
	return id ? `key ${id}` : "API key";
}

function variantsOf(id) {
	const levels =
		VARIANTS[id] ??
		(/^gpt-5\.6/u.test(id)
			? VARIANTS["gpt-5.6-luna"]
			: /^gpt-6/u.test(id)
				? VARIANTS["gpt-6-astra"]
				: undefined);
	if (!levels) return undefined;
	return Object.fromEntries(levels.map((level) => [level, {}]));
}

/**
 * An OpenCode `Model`, which is also what magpie's `config` hook wants. Both
 * `api` and `provider` are written because the two documents disagree on which
 * one carries a per-model API override; they hold the same values, so either
 * reader sees the same thing.
 */
function buildModel(id, base, rate = {}) {
	const rules = rate.billing_rules ?? {};
	const vision = VISION.test(id);
	const variants = variantsOf(id);
	const npm = isClaudeModel(id) ? ANTHROPIC_NPM : OPENAI_NPM;
	const cost = {
		input: numberOr(rate.input_usd_per_1m_tokens, 0),
		output: numberOr(rate.output_usd_per_1m_tokens, 0),
	};
	const cacheRead = positiveNumber(rules.cache_read_usd_per_1m_tokens);
	if (cacheRead !== undefined) cost.cache_read = cacheRead;
	const cacheWrite = positiveNumber(rules.cache_write_usd_per_1m_tokens);
	if (cacheWrite !== undefined) cost.cache_write = cacheWrite;
	return {
		id,
		name: id,
		api: { id, npm, url: apiBase(base) },
		provider: { npm, api: apiBase(base) },
		limit: {
			context: Math.max(1, numberOr(rate.context_window_tokens, 128_000)),
			output: Math.max(1, numberOr(rate.prepay_completion_token_limit, 128_000)),
		},
		capabilities: {
			reasoning: Boolean(variants) || vision,
			toolcall: true,
			attachment: vision,
			input: vision ? { text: true, image: true } : { text: true },
		},
		modalities: { input: vision ? ["text", "image"] : ["text"] },
		cost,
		...(variants ? { variants } : {}),
	};
}

function fallbackCatalog(base) {
	const models = {};
	for (const [id, context, output, input, out, cacheRead] of FALLBACK_ROWS) {
		models[id] = buildModel(id, base, {
			context_window_tokens: context,
			prepay_completion_token_limit: output,
			input_usd_per_1m_tokens: input,
			output_usd_per_1m_tokens: out,
			billing_rules: { cache_read_usd_per_1m_tokens: cacheRead },
		});
	}
	return models;
}

// ---- catalog -------------------------------------------------------------------

async function fetchJson(url, { apiKey, signal } = {}) {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	signal?.addEventListener("abort", onAbort, { once: true });
	const headers = new Headers();
	if (apiKey) {
		headers.set("Authorization", `Bearer ${apiKey}`);
		headers.set("x-api-key", apiKey);
	}
	try {
		const res = await fetch(url, { headers, signal: controller.signal });
		if (!res.ok) {
			throw Object.assign(new Error(`D.AI answered ${res.status}`), { status: res.status });
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Every chat model D.AI publishes, keyed by model id. With a key the catalog is
 * narrowed to the models that key may call; a `/v1/models` failure leaves the
 * full catalog in place rather than hiding every model.
 */
async function fetchCatalog(base, { key, signal } = {}) {
	const docs = await fetchJson(`${base}/api/system/public/capability-docs`, { signal });
	const models = {};
	for (const capability of docs?.data ?? []) {
		if (!CHAT_CAPABILITIES.has(capability?.capability_code)) continue;
		for (const model of capability?.models ?? []) {
			const id = textOf(model?.model_code);
			if (!id || models[id]) continue;
			models[id] = buildModel(id, base, model?.token_rate ?? {});
		}
	}
	if (!key || !Object.keys(models).length) return models;
	try {
		const listed = await fetchJson(`${apiBase(base)}/models`, { apiKey: key, signal });
		const allowed = new Set(
			(listed?.data ?? []).map((model) => textOf(model?.id)).filter(Boolean),
		);
		if (!allowed.size) return models;
		return Object.fromEntries(Object.entries(models).filter(([id]) => allowed.has(id)));
	} catch {
		return models;
	}
}

// ---- the usage card ------------------------------------------------------------

/**
 * What `GET /api/ai/account` says, as magpie's card: the wallet's total, then
 * the tier, this key's own reservation, and today's calls.
 */
function balanceCard(account, key) {
	const balance = account?.balance ?? {};
	const self = account?.api_key ?? {};
	const tier = account?.tier ?? {};
	const parts = [`$${usd(optionalNumber(balance.total) ?? 0)} left`];
	if (textOf(tier.code)) {
		parts.push(
			[
				textOf(tier.code),
				textOf(tier.billing_cycle),
				optionalNumber(tier.expires_in_days) === undefined
					? undefined
					: `${tier.expires_in_days}d left`,
			]
				.filter(Boolean)
				.join(" · "),
		);
	}
	// Only a key with a budget envelope has a reservation; the shared pool has none.
	if (self.envelope_active) {
		const reserved =
			(optionalNumber(self.reserved_package_usd) ?? 0) +
			(optionalNumber(self.reserved_recharge_usd) ?? 0);
		if (reserved > 0) parts.push(`this key $${usd(reserved)}`);
	}
	const calls = optionalNumber(account?.tokens?.today?.calls);
	if (calls !== undefined) {
		parts.push(`${calls} call${calls === 1 ? "" : "s"} today`);
	}
	return {
		plan: textOf(tier.code) || keyLabel(key),
		windows: [{ name: "D.AI balance", display: parts.join(" · ") }],
	};
}

/**
 * The older card, for a D.AI that has not been updated yet: the key's own call
 * log (`GET /api/ai/usage-logs/api-key`) counts calls but knows no balance.
 */
async function callLogCard(base, key) {
	const log = await fetchJson(`${base}/api/ai/usage-logs/api-key?page=1&page_size=1`, {
		apiKey: key,
	});
	const total = numberOr(log?.total, 0);
	const last = Array.isArray(log?.data) ? log.data[0] : undefined;
	const parts = [`${total} call${total === 1 ? "" : "s"}`];
	if (last) {
		const settled = optionalNumber(last.settled_usd);
		parts.push(
			[
				textOf(last.created_at).replace("T", " ").slice(0, 16),
				textOf(last.model_code),
				textOf(last.status),
				settled === undefined ? undefined : `$${usd(settled)}`,
			]
				.filter(Boolean)
				.join(" · "),
		);
	}
	return {
		plan: keyLabel(key),
		windows: [{ name: "D.AI calls", display: parts.join(" · ") }],
	};
}

// ---- plugin --------------------------------------------------------------------

const DaiPlugin = async (_input, options = {}) => {
	const base = normalizeBase(options?.baseUrl ?? process.env.DAI_BASE_URL) ?? DEFAULT_BASE;
	const offline = fallbackCatalog(base);

	// One catalog read per account, reused until it goes stale. Keyed by the
	// API key, never module-global: magpie runs every account of a provider
	// through this one plugin instance.
	const catalogs = new Map();
	const catalogFor = async (key, signal) => {
		const cached = catalogs.get(key);
		if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
		const models = await fetchCatalog(base, { key, signal });
		if (Object.keys(models).length) {
			catalogs.set(key, { at: Date.now(), models });
			return models;
		}
		return undefined;
	};

	return {
		// Declare the provider so it exists before anyone signs in; `??=` keeps
		// whatever the user configured for it in plugins.json.
		config: async (cfg) => {
			cfg.provider ??= {};
			cfg.provider[PROVIDER] ??= {
				name: "D.AI",
				npm: OPENAI_NPM,
				api: apiBase(base),
				models: offline,
			};
		},

		auth: {
			provider: PROVIDER,

			methods: [{ type: "api", label: "D.AI API key", placeholder: "ddsk_…" }],

			async loader(getAuth) {
				const auth = await getAuth();
				const key = textOf(auth?.key);
				if (auth?.type !== "api" || !key) return {};
				return {
					baseURL: apiBase(base),
					apiKey: key,
					headers: { "x-dai-client": "magpie/0.1.0" },
				};
			},

			// The account behind the key: wallet balance, tier and token totals,
			// from D.AI's own endpoint (`GET /api/ai/account`). A `ddsk_` key may
			// call it, which is the point: the plugin can show what a D.AI key
			// cannot otherwise read. The card says the balance as the wallet's
			// total, then how much of it this key may spend and what it has used.
			async usage(getAuth) {
				const auth = await getAuth();
				const key = textOf(auth?.key);
				if (auth?.type !== "api" || !key) {
					return { windows: [], error: "D.AI: sign in with an API key" };
				}
				try {
					const account = await fetchJson(`${base}/api/ai/account`, { apiKey: key });
					return balanceCard(account, key);
				} catch (error) {
					const status = error?.status;
					if (status === 401 || status === 403) {
						return { windows: [], error: "D.AI refused the API key", signIn: "expired" };
					}
					// A deployment older than the endpoint answers 404. Its call log
					// is still there, and counting calls beats showing an error.
					if (status === 404) {
						try {
							return await callLogCard(base, key);
						} catch (fallbackError) {
							return { windows: [], error: String(fallbackError?.message ?? fallbackError) };
						}
					}
					return { windows: [], error: String(error?.message ?? error) };
				}
			},
		},

		provider: {
			id: PROVIDER,

			// The account's own list when D.AI answers, else the catalog the
			// config hook declared, so a failed fetch never empties the provider.
			async models(provider, { auth } = {}) {
				const key = textOf(auth?.key);
				if (!key) return provider.models;
				try {
					const models = await catalogFor(key, undefined);
					return models ?? provider.models;
				} catch {
					return provider.models;
				}
			},
		},
	};
};

// Only the plugin may be a function export: magpie calls every exported
// function as a plugin, and an OpenCode v1 module is `{ id, server }` anyway.
export default { id: PROVIDER, server: DaiPlugin };

/** For tests and manual probing: the pure pieces, never called as a plugin. */
export const _internal = { buildModel, fallbackCatalog, fetchCatalog, keyLabel, normalizeBase };
