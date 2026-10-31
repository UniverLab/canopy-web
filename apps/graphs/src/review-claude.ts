// SPDX-License-Identifier: Apache-2.0
/**
 * The `Muse` review provider: the model behind the index-time pass.
 *
 * It fills the versioned prompt (`prompt.v1.xml`, bundled by
 * `build:review-assets`) with the install-review facts — shell commands,
 * prompt excerpts, attention marks — and the bundled pattern slugs, calls
 * the Muse API (`POST /v1/messages`) with the key from worker secrets,
 * and parses the one JSON object the prompt demands. Anything off-shape
 * — a transport error, a timeout, a non-2xx status, an unparsable body —
 * throws, so the runner leaves that document `unreviewed`. Secrets are
 * never logged: errors carry the status and the document, never the key
 * or the prompt.
 */
import type { JsonValue } from "../../../src/schema.js";
import { isArray, isRecord, isString, parseJson } from "./json.js";
import { REVIEW_PROMPT_V1 } from "./review-assets.generated.js";
import {
  isVerdict,
  reviewFactsOf,
  type ReviewDocument,
  type ReviewProvider,
  type ReviewResult,
  type Verdict,
} from "./review.js";

/** The Muse messages endpoint the provider posts to. */
export const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

/** The Anthropic API version the call declares. */
export const CLAUDE_API_VERSION = "2023-06-01";

/** One provider call's budget: 15 seconds, then the document stays unreviewed. */
export const CLAUDE_TIMEOUT_MS = 15_000;

/** The completion's token ceiling: a verdict plus reasons is short. */
export const CLAUDE_MAX_TOKENS = 1024;

/** The model id the badge names when REVIEW_MODEL is not configured. */
export const CLAUDE_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** What the provider is built from: the secret, the model, and the facts. */
export interface ClaudeOptions {
  /** The worker secret; never logged, never stored. */
  apiKey: string;
  /** The model id the badge shows ("Verdict of <model>"). */
  model: string;
  /** The bundled slugs the model may name. */
  patternSlugs: string[];
  /** The upstream transport; the tests inject a stub table. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout override; production waits 15 seconds. */
  timeoutMs?: number;
  /** Prompt template override; production reads the bundled v1. */
  promptTemplate?: string;
}

/**
 * Fill the prompt template with one document's facts: kind, name, slug,
 * the bundled slugs one per line, and the install-review lines. Pure, so
 * the transparency page and the tests read the same shape the model saw.
 */
export function buildReviewPrompt(
  document: ReviewDocument,
  patternSlugs: string[],
  template: string = REVIEW_PROMPT_V1,
): string {
  const facts = reviewFactsOf(document.kind, document.document);
  return template
    .replaceAll("{{KIND}}", document.kind)
    .replaceAll("{{NAME}}", document.name)
    .replaceAll("{{SLUG}}", document.slug)
    .replaceAll("{{PATTERNS}}", patternSlugs.length === 0 ? "(none)" : patternSlugs.join("\n"))
    .replaceAll("{{COMMANDS}}", facts.commands)
    .replaceAll("{{PROMPTS}}", facts.prompts)
    .replaceAll("{{ATTENTION}}", facts.attention);
}

/** The model's JSON once extracted: verdict, reasons, patterns. */
interface ModelAnswer {
  verdict: Verdict;
  reasons: string;
  patterns: string[];
}

/**
 * Extract the one JSON object from the model's text: verbatim first, then
 * the span from the first `{` to the last `}`. Throws when nothing there
 * parses or the shape is off — the caller leaves it `unreviewed`.
 */
export function parseModelAnswer(text: string): ModelAnswer {
  const candidates = [text.trim()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    const parsed = parseJson(candidate);
    if (!parsed.ok || !isRecord(parsed.value)) {
      continue;
    }
    const verdict = parsed.value["verdict"];
    const reasons = parsed.value["reasons"];
    const patterns = parsed.value["patterns"];
    if (!isVerdict(verdict) || !isString(reasons) || !isArray(patterns)) {
      continue;
    }
    if (!patterns.every(isString)) {
      continue;
    }
    return { verdict, reasons, patterns: [...patterns] };
  }
  throw new Error("the model answer is not the verdict JSON");
}

/** Read the text of a messages answer; throws when the shape is off. */
function answerText(body: unknown): string {
  if (!isRecord(body) || !isArray(body["content"])) {
    throw new Error("the Muse answer held no content");
  }
  for (const block of body["content"]) {
    if (isRecord(block) && block["type"] === "text" && isString(block["text"])) {
      return block["text"];
    }
  }
  throw new Error("the Muse answer held no text");
}

/**
 * Build the `Muse` provider over an injected transport. Nodes always
 * answer no patterns, whatever the model named; graphs keep only bundled
 * slugs. The key travels in the `x-api-key` header and nowhere else.
 */
export function createClaudeProvider(options: ClaudeOptions): ReviewProvider {
  const model = options.model;
  const known = new Set(options.patternSlugs);
  const template = options.promptTemplate ?? REVIEW_PROMPT_V1;
  const timeoutMs = options.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    model,
    async review(document: ReviewDocument): Promise<ReviewResult> {
      const prompt = buildReviewPrompt(document, options.patternSlugs, template);
      let response: Response;
      try {
        response = await fetchImpl(CLAUDE_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": CLAUDE_API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: CLAUDE_MAX_TOKENS,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error("the Muse call failed");
      }
      if (!response.ok) {
        throw new Error(`the Muse call answered ${response.status}`);
      }
      let body: JsonValue;
      try {
        body = (await response.json()) as JsonValue;
      } catch {
        throw new Error("the Muse answer is not JSON");
      }
      const answer = parseModelAnswer(answerText(body));
      const patterns = document.kind === "node"
        ? []
        : [...new Set(answer.patterns.filter((slug) => known.has(slug)))].sort();
      return { verdict: answer.verdict, reasons: answer.reasons.trim().slice(0, 1000), patterns };
    },
  };
}
