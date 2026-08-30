/**
 * LLM provider abstraction. The review service only ever talks to
 * `LlmProvider.complete()`, so swapping Groq for another vendor, or one Groq
 * model for another, is a configuration change rather than a code change.
 */
import Groq from "groq-sdk";
import { config } from "../config.js";

export class LlmProvider {
  get name() {
    return "none";
  }
  get available() {
    return false;
  }
  /**
   * @param {object} req
   * @param {string} req.system
   * @param {string} req.user
   * @param {boolean} [req.json]  ask for a JSON object response
   * @param {number} [req.maxTokens]
   * @param {number} [req.temperature]
   * @param {"default"|"fast"} [req.tier]
   * @returns {Promise<string|null>} raw text, or null when unavailable
   */
  async complete() {
    return null;
  }
}

export class NullProvider extends LlmProvider {}

/**
 * Preference lists used when a configured model is not available to the key
 * (Groq retires and renames models regularly). Order = quality preference.
 */
const PREFERRED = {
  default: [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "moonshotai/kimi-k2-instruct-0905",
    "moonshotai/kimi-k2-instruct",
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "qwen/qwen3-32b",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
  ],
  fast: [
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "qwen/qwen3.6-27b",
    "qwen/qwen3.8-27b",
    "qwen/qwen3-32b",
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
  ],
};

// Models that exist in the catalogue but are not general chat models.
const NOT_CHAT = /whisper|tts|guard|orpheus|embed|compound|vision|safeguard|prompt-guard|playai|allam/i;

export class GroqProvider extends LlmProvider {
  constructor({ apiKey, model, fallbackModel, fastModel, temperature, maxTokens, timeoutMs }) {
    super();
    this.client = new Groq({ apiKey, timeout: timeoutMs, maxRetries: 3 });
    this.configured = { model, fallbackModel, fastModel: fastModel || fallbackModel || model };
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.fastModel = this.configured.fastModel;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.resolved = null;
    this.stats = { requests: 0, failures: 0, promptTokens: 0, completionTokens: 0, byModel: {} };
  }

  get name() {
    return `groq:${this.model}`;
  }
  get available() {
    return true;
  }

  /**
   * Check the configured models against the account's catalogue once and
   * substitute the best available alternative for anything missing.
   */
  async resolveModels() {
    if (this.resolved) return this.resolved;
    this.resolved = (async () => {
      let ids = null;
      try {
        const res = await this.client.models.list();
        ids = new Set(res.data.filter((m) => m.active !== false && !NOT_CHAT.test(m.id)).map((m) => m.id));
      } catch (err) {
        console.warn("[llm] could not list Groq models; using configured names as-is:", err.message);
        return;
      }
      const pick = (wanted, tier) => {
        if (wanted && ids.has(wanted)) return wanted;
        const alt = PREFERRED[tier].find((id) => ids.has(id)) || [...ids].find((id) => /instruct|versatile|instant|gpt-oss|llama|qwen|kimi/i.test(id)) || [...ids][0];
        if (wanted) console.warn(`[llm] model "${wanted}" is not available; using "${alt}"`);
        return alt;
      };
      this.model = pick(this.configured.model, "default");
      this.fastModel = pick(this.configured.fastModel, "fast");
      const fb = this.configured.fallbackModel;
      this.fallbackModel = fb && ids.has(fb) ? fb : PREFERRED.default.find((id) => ids.has(id) && id !== this.model) || null;
      console.log(`[llm] models: review=${this.model} hints=${this.fastModel} fallback=${this.fallbackModel || "none"}`);
    })();
    return this.resolved;
  }

  /** Keep reasoning models' hidden thinking short so the answer fits the token budget. */
  static reasoningParams(model) {
    if (/gpt-oss/i.test(model)) return { reasoning_effort: "low" };
    if (/qwen3/i.test(model)) return { reasoning_effort: "none" };
    return null;
  }

  async complete({ system, user, json = false, maxTokens, temperature, tier = "default" }) {
    await this.resolveModels();
    const primary = tier === "fast" ? this.fastModel : this.model;
    const candidates = [primary];
    if (this.fallbackModel && this.fallbackModel !== primary) candidates.push(this.fallbackModel);
    // Reasoning models need headroom beyond the visible answer.
    const budget = maxTokens ?? this.maxTokens;

    let lastErr;
    for (const model of candidates) {
      const reasoning = GroqProvider.reasoningParams(model);
      // Attempt ladder per model: full options -> without reasoning params -> without JSON mode.
      const variants = [
        { ...(reasoning || {}), ...(json ? { response_format: { type: "json_object" } } : {}) },
        ...(reasoning ? [{ ...(json ? { response_format: { type: "json_object" } } : {}) }] : []),
        ...(json ? [{}] : []),
      ];
      for (const extra of variants) {
        this.stats.requests++;
        try {
          const res = await this.client.chat.completions.create({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: temperature ?? this.temperature,
            max_tokens: reasoning ? Math.round(budget * 2) : budget,
            ...extra,
          });
          const usage = res.usage || {};
          this.stats.promptTokens += usage.prompt_tokens || 0;
          this.stats.completionTokens += usage.completion_tokens || 0;
          this.stats.byModel[model] = (this.stats.byModel[model] || 0) + 1;
          const text = res.choices?.[0]?.message?.content;
          if (text && text.trim()) return text;
          lastErr = new Error("Empty completion");
          break; // an empty answer will not improve by dropping options; try next model
        } catch (err) {
          this.stats.failures++;
          lastErr = err;
          const status = err?.status ?? err?.response?.status;
          if (status === 400 || status === 422) continue; // unsupported option: try the next variant
          if (status && ![404, 413, 429, 503].includes(status)) throw err;
          console.warn(`[llm] ${model} failed (${status ?? err.message}); trying fallback`);
          break;
        }
      }
    }
    throw lastErr || new Error("LLM completion failed");
  }
}

/** Tolerant JSON extraction for model output that may include fences or prose. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

export function createLlmProvider() {
  if (config.groq.apiKey) {
    return new GroqProvider({
      apiKey: config.groq.apiKey,
      model: config.groq.model,
      fallbackModel: config.groq.fallbackModel,
      fastModel: process.env.GROQ_HINT_MODEL || config.groq.fallbackModel,
      temperature: config.groq.temperature,
      maxTokens: config.groq.maxTokens,
      timeoutMs: config.groq.timeoutMs,
    });
  }
  return new NullProvider();
}

export const llm = createLlmProvider();
