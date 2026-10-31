// SPDX-License-Identifier: Apache-2.0
/**
 * The `meta` review provider: the model behind the index-time pass.
 *
 * It fills the same versioned prompt the `Muse` provider sends
 * (`prompt.v1.xml`, leading comments stripped by `buildReviewPrompt`),
 * calls the configured chat-completions-style endpoint (`POST` with the
 * key as a Bearer token), and parses the one JSON object the prompt
 * demands. Verified live 2026-10-31 against Meta's chat-completions
 * endpoint with a muse-spark model: the answers are OpenAI-compatible
 * `chat.completion` bodies (`choices[0].message.content`, `usage` with a
 * reasoning split), and that is the shape read here — anything else
 * throws, so the runner leaves that document `unreviewed`. Secrets are
 * never logged: errors carry the status and the document, never the key
 * or the prompt.
 *
 * Nothing here is defaulted into existence: the endpoint
 * (`META_API_BASE_URL`), the model (`REVIEW_MODEL`, sent verbatim) and
 * the key (`META_API_KEY`) all arrive as configuration, and a missing
 * one refuses before the first call. The reasoning effort
 * (`REVIEW_EFFORT`, minimal|low|medium|high) passes through to the call
 * and defaults to `minimal`, measured cheapest on real review prompts.
 * The completion budget (`REVIEW_MAX_TOKENS`) is clamped to a floor that
 * survives reasoning and a ceiling that keeps it bounded, so the call
 * never runs unbounded and never starves to `content: null`.
 *
 * One bounded repair retry: when an answer fails to parse (after the
 * verbatim-then-extract fallback), the provider retries once with a
 * repair instruction prepended; a second failure throws exactly as a
 * first failure does. At most two provider calls per document per run.
 * Every attempt logs its token usage and the effort used — numbers
 * only, never the key or the document.
 */
import type { JsonValue } from "../../../src/schema.js";
import type { Log } from "./github.js";
import { isArray, isRecord, isString } from "./json.js";
import { REVIEW_PROMPT_V1 } from "./review-assets.generated.js";
import {
  type ReviewDocument,
  type ReviewProvider,
  type ReviewResult,
} from "./review.js";
import { buildReviewPrompt, parseModelAnswer } from "./review-claude.js";

/** The reasoning efforts the call passes through, cheapest first. */
export type MetaEffort = "minimal" | "low" | "medium" | "high";

/** The effort the call uses when REVIEW_EFFORT is absent or unknown. */
export const META_DEFAULT_EFFORT: MetaEffort = "minimal";

/** One provider call's budget: reasoning models answer slower than chat ones. */
export const META_TIMEOUT_MS = 30_000;

/** The completion budget when REVIEW_MAX_TOKENS is absent or unparsable. */
export const META_DEFAULT_MAX_TOKENS = 4096;

/**
 * The completion budget's floor: below this a reasoning model starves to
 * `content: null` on real review prompts. The configured value is raised
 * to this, never lowered past it.
 */
export const META_MIN_MAX_TOKENS = 1024;

/** The completion budget's ceiling: the call is never unbounded. */
export const META_MAX_MAX_TOKENS = 16384;

/**
 * The repair instruction prepended to the prompt on the one retry: the
 * first answer failed to parse, so the second attempt asks for the bare
 * object only.
 */
export const META_REPAIR_INSTRUCTION = "Reply with ONLY the JSON object, no fences, no commentary.";

/** True when the value is one of the four efforts. */
function isMetaEffort(value: unknown): value is MetaEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}

/**
 * Read the effort from configuration: the value verbatim when it is one
 * of the four, `minimal` otherwise. Case-insensitive, like the provider
 * name.
 */
export function resolveMetaEffort(value: string | undefined): MetaEffort {
  const effort = (value ?? "").trim().toLowerCase();
  return isMetaEffort(effort) ? effort : META_DEFAULT_EFFORT;
}

/**
 * Read the completion budget from configuration: the value clamped to
 * the floor and the ceiling, the default when it is absent or
 * unparsable. A number passes through the same clamp, so the provider
 * call never runs unbounded and never starves, however it was built.
 */
export function resolveMetaMaxTokens(value: string | number | undefined): number {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) {
    return META_DEFAULT_MAX_TOKENS;
  }
  return Math.min(META_MAX_MAX_TOKENS, Math.max(META_MIN_MAX_TOKENS, parsed));
}

/** What the provider is built from: the secret, the endpoint, the model, the facts. */
export interface MetaOptions {
  /** The worker secret; travels in the Authorization header, never logged. */
  apiKey: string;
  /** The full chat-completions endpoint URL, used verbatim — no default exists. */
  baseUrl: string;
  /** The model id, sent verbatim and shown on the badge ("Verdict of <model>"). */
  model: string;
  /** The bundled slugs the model may name. */
  patternSlugs: string[];
  /** The reasoning effort; `minimal` when absent or unknown. */
  effort?: string;
  /** The completion budget; clamped to the floor and the ceiling. */
  maxTokens?: string | number;
  /** The upstream transport; the tests inject a stub table. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout override; production waits 30 seconds. */
  timeoutMs?: number;
  /** Prompt template override; production reads the bundled v1. */
  promptTemplate?: string;
  /** Where token usage is noted; defaults to no-op. */
  log?: Log;
}

/** One attempt's token usage, as the answer's `usage` carried it. */
interface MetaUsage {
  prompt: number;
  completion: number;
  total: number;
}

/** One attempt's answer: the text to parse plus what it cost. */
interface MetaAnswer {
  text: string;
  usage: MetaUsage;
}

/** Read one usage counter; anything off-shape is zero, never an exception. */
function usageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Read the attempt's token usage; a missing `usage` costs nothing on paper. */
function answerUsage(body: unknown): MetaUsage {
  if (!isRecord(body) || !isRecord(body["usage"])) {
    return { prompt: 0, completion: 0, total: 0 };
  }
  return {
    prompt: usageCount(body["usage"]["prompt_tokens"]),
    completion: usageCount(body["usage"]["completion_tokens"]),
    total: usageCount(body["usage"]["total_tokens"]),
  };
}

/**
 * Read the text of a chat.completion answer; throws when the shape is
 * off — no choices, no message, or a null content the budget starved.
 */
function answerText(body: unknown): string {
  if (!isRecord(body) || !isArray(body["choices"])) {
    throw new Error("the Meta answer held no choices");
  }
  const first = body["choices"][0];
  if (!isRecord(first) || !isRecord(first["message"])) {
    throw new Error("the Meta answer held no message");
  }
  const content = first["message"]["content"];
  if (!isString(content) || content === "") {
    throw new Error("the Meta answer held no content");
  }
  return content;
}

/**
 * Build the `meta` provider over an injected transport. Nodes always
 * answer no patterns, whatever the model named; graphs keep only bundled
 * slugs. The key travels in the `Authorization` header and nowhere else.
 */
export function createMetaProvider(options: MetaOptions): ReviewProvider {
  const model = options.model;
  const effort = resolveMetaEffort(options.effort);
  const maxTokens = resolveMetaMaxTokens(options.maxTokens);
  const known = new Set(options.patternSlugs);
  const template = options.promptTemplate ?? REVIEW_PROMPT_V1;
  const timeoutMs = options.timeoutMs ?? META_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);

  function usageLine(document: ReviewDocument, attempt: number, usage: MetaUsage): void {
    log(
      `review: meta ${document.owner}/${document.repo} ${document.slug} ` +
      `effort=${effort} attempt=${attempt} ` +
      `prompt=${usage.prompt} completion=${usage.completion} total=${usage.total}`,
    );
  }

  function finish(document: ReviewDocument, text: string): ReviewResult {
    const answer = parseModelAnswer(text);
    const patterns = document.kind === "node"
      ? []
      : [...new Set(answer.patterns.filter((slug) => known.has(slug)))].sort();
    return { verdict: answer.verdict, reasons: answer.reasons.trim().slice(0, 1000), patterns };
  }

  async function call(prompt: string): Promise<MetaAnswer> {
    let response: Response;
    try {
      response = await fetchImpl(options.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          reasoning_effort: effort,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("the Meta call failed");
    }
    if (!response.ok) {
      throw new Error(`the Meta call answered ${response.status}`);
    }
    let body: JsonValue;
    try {
      body = (await response.json()) as JsonValue;
    } catch {
      throw new Error("the Meta answer is not JSON");
    }
    return { text: answerText(body), usage: answerUsage(body) };
  }

  return {
    model,
    async review(document: ReviewDocument): Promise<ReviewResult> {
      const prompt = buildReviewPrompt(document, options.patternSlugs, template);
      const first = await call(prompt);
      usageLine(document, 1, first.usage);
      try {
        return finish(document, first.text);
      } catch {
        // Unparsable even after the verbatim-then-extract fallback: one
        // retry with the repair instruction, then unreviewed as today.
        const second = await call(`${META_REPAIR_INSTRUCTION}\n\n${prompt}`);
        usageLine(document, 2, second.usage);
        return finish(document, second.text);
      }
    },
  };
}
