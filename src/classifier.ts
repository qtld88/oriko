import { requestUrl } from "obsidian";
import {
  NO_VERDICT,
  buildLlmMessages,
  buildSystemOneRequest,
  readLlmResponse,
  readSystemOneResponse,
  usableCategories,
} from "./core/classify";
import type { Classification, SortCategory, Verdict } from "./core/classify";
import type { OrikoSettings } from "./core/settings";

/**
 * Asking a model where a clipping belongs.
 *
 * A clip must never fail because sorting did. Every path out of this file
 * returns a verdict, and NO_VERDICT is a perfectly good one: it means the note
 * is written unsorted and a person decides later.
 */
/**
 * Two guards, because the engines are two different machines. A System One
 * model answers a batch of questions in tens of milliseconds, so anything past
 * a second means the endpoint is not there. A chat model generating forty
 * tokens takes seconds: llama3.2:3b on an M-series laptop was measured at 9.6 s
 * for exactly the request this file sends, so a five second guard would have
 * timed a working local setup out every single time.
 *
 * Neither costs wall-clock time in the normal case: the call runs beside a
 * media download that already takes seconds.
 */
const SYSTEM_ONE_TIMEOUT_MS = 5000;
const LLM_TIMEOUT_MS = 30000;

function withTimeout<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** What one engine came back with, and whether it answered at all. */
interface EngineResult {
  verdict: Verdict;
  /** True when the server replied with a usable status, whatever it decided. */
  reached: boolean;
}

const UNREACHED: EngineResult = { verdict: NO_VERDICT, reached: false };

function mergeTags(first: readonly string[], second: readonly string[]): string[] {
  const out = [...first];
  for (const tag of second) if (!out.includes(tag)) out.push(tag);
  return out;
}

export class Classifier {
  constructor(private settings: () => OrikoSettings) {}

  /**
   * The System One engine leads when it is configured, and the chat engine
   * picks up whatever it leaves: an answer below the threshold and an endpoint
   * that never replied come out the same way here, which is what makes a local
   * sidecar usable from a phone that cannot reach it.
   */
  async classify(state: string): Promise<Classification> {
    const s = this.settings();
    if (!s.autoSort) return { verdict: NO_VERDICT, outcome: "off" };

    const categories = usableCategories(s.sortCategories);
    // Declaring nothing is the commonest reason a clipping comes back
    // unsorted, and the least guessable. It gets an outcome of its own so the
    // notice can say what to do about it.
    if (categories.length === 0) return { verdict: NO_VERDICT, outcome: "no-categories" };
    const tags = usableCategories(s.sortTags);

    const hasLlm = Boolean(s.sortLlmBaseUrl && s.sortLlmModel);
    if (!s.sortEndpoint && !hasLlm) {
      return { verdict: NO_VERDICT, outcome: "unavailable" };
    }

    let reached = false;
    let carried: Verdict = NO_VERDICT;

    if (s.sortEndpoint) {
      const first = await withTimeout(
        this.askSystemOne(state, categories, tags),
        UNREACHED,
        SYSTEM_ONE_TIMEOUT_MS
      );
      reached = first.reached;
      carried = first.verdict;
      if (first.verdict.category) return { verdict: first.verdict, outcome: "sorted" };
    }

    // No threshold here, and none available. The chat engine reports no
    // calibrated probability of its own, and a model asked how sure it is
    // answers with a number it made up, so gating on that would be theatre.
    // Only the decision endpoint can genuinely say it does not know, which is
    // the strongest reason to configure one rather than run on chat alone.
    if (hasLlm) {
      const second = await withTimeout(
        this.askLlm(state, categories),
        UNREACHED,
        LLM_TIMEOUT_MS
      );
      reached = reached || second.reached;
      if (second.verdict.category) {
        // Tags survive a refused category: the typed engine may have answered
        // the yes-or-no questions well while being unsure of the category.
        return {
          verdict: { ...second.verdict, tags: mergeTags(carried.tags, second.verdict.tags) },
          outcome: "sorted",
        };
      }
    }

    return { verdict: carried, outcome: reached ? "unsure" : "unavailable" };
  }

  private async askSystemOne(
    state: string,
    categories: readonly SortCategory[],
    tags: readonly SortCategory[]
  ): Promise<EngineResult> {
    const s = this.settings();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // A local sidecar wants no bearer token, and sending an empty one makes
    // some servers reject the request outright.
    if (s.sortApiKey) headers.Authorization = `Bearer ${s.sortApiKey}`;

    const response = await requestUrl({
      url: s.sortEndpoint,
      method: "POST",
      headers,
      body: JSON.stringify(buildSystemOneRequest(state, categories, tags)),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) return UNREACHED;
    return {
      verdict: readSystemOneResponse(response.json, categories, tags, s.sortThreshold),
      reached: true,
    };
  }

  private async askLlm(
    state: string,
    categories: readonly SortCategory[]
  ): Promise<EngineResult> {
    const s = this.settings();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (s.sortLlmApiKey) headers.Authorization = `Bearer ${s.sortLlmApiKey}`;

    const base = s.sortLlmBaseUrl.replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${base}/chat/completions`,
      method: "POST",
      headers,
      body: JSON.stringify(buildLlmMessages(state, categories, s.sortLlmModel)),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) return UNREACHED;

    const body = response.json as { choices?: { message?: { content?: string } }[] };
    return {
      verdict: readLlmResponse(body?.choices?.[0]?.message?.content ?? "", categories),
      reached: true,
    };
  }
}
