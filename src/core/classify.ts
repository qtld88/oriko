/**
 * Deciding which category and which tags a clipping carries, with no network
 * and no Obsidian imports, so every branch is reachable from a unit test.
 * The network and the engine order live in ../classifier.ts.
 *
 * Two engines answer the same question. A System One model (Laya locally,
 * TypeSafe Jev hosted) returns typed answers with a probability per option. An
 * OpenAI-compatible chat endpoint returns JSON that has to be parsed and
 * distrusted. Design: docs/superpowers/specs/2026-09-22-auto-sorting-design.md.
 */

/** One declared category or tag. The name is also the folder and grid name. */
export interface SortCategory {
  name: string;
  /** What the model matches the clipping against. Never decoration. */
  description: string;
}

/** Where the decided category goes, besides `categories:`. */
export type SortDestination = "property" | "subfolder" | "grid" | "folder";

export interface Verdict {
  /** A declared category, or "" when nothing was decided. */
  category: string;
  /** Declared tags that applied, in declaration order. */
  tags: string[];
  /** The winning option's probability. 0 when no engine answered. */
  probability: number;
}

/**
 * Why a clipping ended up where it did. Four of these leave it unsorted, and
 * they are not the same thing: the model hedged, a server never spoke, no
 * category was ever declared, or the page offered no text to read. Telling a
 * user the wrong one sends them debugging the wrong thing.
 *
 * "fallback" is the model hedging on a clipping whose owner named a place for
 * those. It is its own outcome so the notice can say the filing was a default
 * and not a decision.
 */
export type SortOutcome =
  | "sorted"
  | "fallback"
  | "unsure"
  | "unavailable"
  | "no-categories"
  | "no-text"
  | "off";

export interface Classification {
  verdict: Verdict;
  outcome: SortOutcome;
}

/** Nothing decided. Returned wherever an engine fails to produce an answer. */
export const NO_VERDICT: Verdict = { category: "", tags: [], probability: 0 };

/**
 * The declarations worth sending. The settings list is edited row by row, so a
 * row half typed when a clip arrives is normal rather than exceptional, and a
 * blank name would become a nameless option in the criteria map. Duplicates
 * keep the first: criteria is a map, so the last would silently win otherwise.
 */
export function usableCategories(list: readonly SortCategory[]): SortCategory[] {
  const seen = new Set<string>();
  const out: SortCategory[] = [];
  for (const item of list) {
    const name = item.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: item.description.trim() });
  }
  return out;
}

interface SystemOneQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string>;
}

export interface SystemOneRequest {
  state: string;
  questions: Record<string, SystemOneQuestion>;
}

/** The id the category question is asked and answered under. */
export const CATEGORY_ID = "category";

/** Tag ids are prefixed so a tag named "category" cannot shadow the choice. */
export const TAG_PREFIX = "tag:";

/**
 * One request carries the category question and every tag question. These
 * models evaluate each question in isolation and in a single forward pass, so
 * asking twenty tags costs almost what asking one costs.
 */
export function buildSystemOneRequest(
  state: string,
  categories: readonly SortCategory[],
  tags: readonly SortCategory[]
): SystemOneRequest {
  // A description is optional. Where one is missing the name stands in for it:
  // these models match the clipping against the option's text, so sending an
  // empty string is strictly worse than sending "DESIGN" twice.
  const criteria: Record<string, string> = {};
  for (const item of categories) criteria[item.name] = item.description || item.name;

  const questions: Record<string, SystemOneQuestion> = {
    [CATEGORY_ID]: {
      type: "choice",
      instructions: "Which category is this web page about?",
      criteria,
    },
  };

  for (const tag of tags) {
    questions[`${TAG_PREFIX}${tag.name}`] = {
      // A statement, not a question: these models score entailment between the
      // state and the option text, and a declarative reads better as one.
      type: "noul",
      instructions: `This web page is about ${tag.description || tag.name}`,
    };
  }

  return { state, questions };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The threshold is compared against the winning option's probability, never
 * against the engine's own `confidence`. Both engines report confidence as one
 * minus the normalised entropy of the distribution, which collapses as soon as
 * probability is spread across several options even when the winner is far
 * ahead. With half a dozen categories that would reject correct answers on the
 * shape of the distribution rather than on the answer.
 */
export function readSystemOneResponse(
  body: unknown,
  categories: readonly SortCategory[],
  tags: readonly SortCategory[],
  threshold: number
): Verdict {
  const answers = asRecord(asRecord(body)?.answers);
  if (!answers) return NO_VERDICT;

  let category = "";
  let probability = 0;
  const choice = asRecord(answers[CATEGORY_ID]);
  if (choice) {
    const declared = new Set(categories.map((item) => item.name));
    const name = typeof choice.choice === "string" ? choice.choice : "";
    const probabilities = asRecord(choice.probabilities);
    const p = probabilities ? asNumber(probabilities[name]) : 0;
    // An undeclared category is treated exactly like an unsure one: the user
    // never declared a folder for it, so there is nowhere for it to go.
    if (declared.has(name) && p >= threshold) {
      category = name;
      probability = p;
    }
  }

  // Declaration order, not response order: the settings list is the one the
  // user arranged, and a note's tags should not shuffle between clips.
  const applied: string[] = [];
  for (const tag of tags) {
    const answered = asRecord(answers[`${TAG_PREFIX}${tag.name}`]);
    if (answered && asNumber(answered.noul) >= threshold) applied.push(tag.name);
  }

  return { category, tags: applied, probability };
}

export interface LlmRequest {
  model: string;
  messages: { role: string; content: string }[];
  response_format: { type: "json_object" };
  temperature: number;
}

/**
 * The second engine, for endpoints speaking the OpenAI chat format: OpenAI,
 * Groq, OpenRouter, Ollama, LM Studio. Unlike a System One model it can invent
 * tags, which is the whole reason to offer it beside the other.
 */
export function buildLlmMessages(
  state: string,
  categories: readonly SortCategory[],
  model: string
): LlmRequest {
  const list = categories
    .map((item) => (item.description ? `- ${item.name}: ${item.description}` : `- ${item.name}`))
    .join("\n");
  return {
    model,
    messages: [
      {
        role: "system",
        content:
          "You sort saved web pages. Reply with a JSON object and nothing else, " +
          'shaped {"category": string, "tags": string[]}. Pick the category from ' +
          "this list, using its description to tell them apart:\n" +
          list +
          "\nUse an empty string for the category if none fits. Give three to " +
          "five short lowercase tags describing the subject.",
      },
      { role: "user", content: state },
    ],
    response_format: { type: "json_object" },
    // Sorting is not a creative task, and a reproducible answer is worth more
    // than a varied one.
    temperature: 0,
  };
}

/**
 * A chat model can be asked for JSON and still wrap it in prose or a fence, so
 * the first balanced object in the reply is what gets parsed. A reply that
 * yields nothing is an engine that did not answer, not an error to surface: the
 * caller falls through and the clipping is left unsorted.
 */
export function readLlmResponse(text: string, categories: readonly SortCategory[]): Verdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return NO_VERDICT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return NO_VERDICT;
  }

  const body = asRecord(parsed);
  if (!body) return NO_VERDICT;

  const declared = new Set(categories.map((item) => item.name));
  const name = typeof body.category === "string" ? body.category : "";
  const category = declared.has(name) ? name : "";

  const tags = Array.isArray(body.tags)
    ? body.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : [];

  // A chat model reports no probability of its own. Saying 1 rather than 0
  // keeps "did an engine answer" readable at the call site without inventing a
  // number that looks measured.
  return { category, tags, probability: category ? 1 : 0 };
}

/**
 * Files a hedged clipping under the category the user picked for those.
 *
 * Only "unsure" qualifies: a model that answered and would not commit. The
 * other unsorted outcomes are not hedging, and hiding them in a folder would
 * hide what is actually wrong. A server that never answered filed every clip
 * under MISC would look like a working setup with a lot of miscellany.
 *
 * The fallback is checked against the declared list on every clip, not when
 * the setting is saved. A category renamed or deleted afterwards leaves the
 * setting pointing at nothing, and a clip must not be filed into a folder
 * the user no longer has a category for.
 */
export function withFallback(
  result: Classification,
  fallback: string,
  categories: readonly SortCategory[]
): Classification {
  if (result.outcome !== "unsure") return result;
  const wanted = fallback.trim();
  const declared = usableCategories(categories).find((item) => item.name === wanted);
  if (!declared) return result;
  return {
    verdict: { ...result.verdict, category: declared.name, probability: 0 },
    outcome: "fallback",
  };
}

/** Extra frontmatter for a note, merged by buildNote in ./resolve.ts. */
export interface NoteExtras {
  /** Whole frontmatter lines, already formatted and escaped. */
  lines: string[];
  /** Tag values appended after the built-in "clippings". */
  tags: string[];
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** The keys a decided category writes, whatever form they end up in. */
export interface DestinationFields {
  categories: string[];
  grid?: string;
  folder?: string;
}

/**
 * The destination rules, once. A new note gets them as YAML lines through
 * verdictExtras; a note the sweep sorts later gets them as a frontmatter
 * patch through ./unsorted.ts. Values are raw: escaping is the writer's job.
 */
export function destinationFields(
  verdict: Verdict,
  destination: SortDestination
): DestinationFields {
  if (!verdict.category) return { categories: [] };
  const fields: DestinationFields = { categories: [verdict.category] };
  if (destination === "grid") fields.grid = verdict.category;
  if (destination === "folder") fields.folder = verdict.category;
  return fields;
}

/**
 * `categories:` is written whatever the destination, so changing the
 * destination setting later changes where new clippings go without stranding
 * the ones already filed. The destination adds to that, never replaces it.
 *
 * An undecided clipping gets `unsorted: true` and no category. Not `status:`,
 * which Oriko already uses for read state with an "unread" default: a second
 * meaning on that key would corrupt the facet built on it. The marker is also
 * the queue the sweep drains, see ./unsorted.ts.
 */
export function verdictExtras(verdict: Verdict, destination: SortDestination): NoteExtras {
  if (!verdict.category) return { lines: ["unsorted: true"], tags: verdict.tags };

  const fields = destinationFields(verdict, destination);
  const lines = ["categories:", ...fields.categories.map((name) => `  - ${yamlString(name)}`)];
  if (fields.grid !== undefined) lines.push(`grid: ${yamlString(fields.grid)}`);
  if (fields.folder !== undefined) lines.push(`folder: ${yamlString(fields.folder)}`);
  return { lines, tags: verdict.tags };
}

/** The subfolder a clipping is written into, or "" to leave it at the root. */
export function verdictSubfolder(verdict: Verdict, destination: SortDestination): string {
  return destination === "subfolder" ? verdict.category : "";
}

/**
 * What the model reads: the description alone, and the title only when there
 * is no description.
 *
 * The title and the URL were sent too until a run over 47 labelled clippings
 * measured what they cost. Accuracy went from 55% to 72% once they were
 * dropped. Both carry the platform rather than the subject, and they bracket
 * the text that does carry it: "Jean-Luc Mélenchon (@jlmelenchon) on Threads"
 * followed by a paragraph on fuel prices, then threads.com, was filed under
 * TECH. Two mentions of a social network outvoted the politics between them.
 *
 * A page with neither yields an empty state, and an empty state is the honest
 * answer: there is nothing to sort on, so the clipping stays unsorted instead
 * of being filed on the strength of a domain name.
 */
export function clippingState(title: string, description: string, _url: string): string {
  return description.trim() || title.trim();
}
