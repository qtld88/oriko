import { requestUrl } from "obsidian";
import {
  NO_VERDICT,
  buildLlmMessages,
  buildSystemOneRequest,
  readLlmResponse,
  readSystemOneResponse,
  usableCategories,
} from "./core/classify";
import type { SortCategory, Verdict } from "./core/classify";
import type { OrikoSettings } from "./core/settings";

/**
 * Asking a model where a clipping belongs.
 *
 * A clip must never fail because sorting did. Every path out of this file
 * returns a verdict, and NO_VERDICT is a perfectly good one: it means the note
 * is written unsorted and a person decides later.
 */
const TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

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
  async classify(state: string): Promise<Verdict> {
    const s = this.settings();
    if (!s.autoSort) return NO_VERDICT;

    const categories = usableCategories(s.sortCategories);
    // No categories means no question worth asking. Silent on purpose: the
    // list's own empty state in the settings pane is where someone can act on
    // it, and a notice on every clip would be noise.
    if (categories.length === 0) return NO_VERDICT;
    const tags = usableCategories(s.sortTags);

    const hasLlm = Boolean(s.sortLlmBaseUrl && s.sortLlmModel);

    if (s.sortEndpoint) {
      const first = await withTimeout(this.askSystemOne(state, categories, tags), NO_VERDICT);
      if (first.category || !hasLlm) return first;
      // Tags survive a refused category: the typed engine may have answered
      // the yes-or-no questions well while being unsure of the category.
      const second = await withTimeout(this.askLlm(state, categories), NO_VERDICT);
      if (!second.category) return first;
      return { ...second, tags: mergeTags(first.tags, second.tags) };
    }

    if (hasLlm) return withTimeout(this.askLlm(state, categories), NO_VERDICT);

    return NO_VERDICT;
  }

  private async askSystemOne(
    state: string,
    categories: readonly SortCategory[],
    tags: readonly SortCategory[]
  ): Promise<Verdict> {
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
    if (response.status < 200 || response.status >= 300) return NO_VERDICT;
    return readSystemOneResponse(response.json, categories, tags, s.sortThreshold);
  }

  private async askLlm(
    state: string,
    categories: readonly SortCategory[]
  ): Promise<Verdict> {
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
    if (response.status < 200 || response.status >= 300) return NO_VERDICT;

    const body = response.json as { choices?: { message?: { content?: string } }[] };
    return readLlmResponse(body?.choices?.[0]?.message?.content ?? "", categories);
  }
}
