import { describe, expect, it } from "vitest";
import {
  buildLlmMessages,
  buildSystemOneRequest,
  clippingState,
  destinationFields,
  readLlmResponse,
  readSystemOneResponse,
  usableCategories,
  verdictExtras,
  verdictSubfolder,
  withFallback,
} from "../src/core/classify";
import type { Classification, SortCategory, SortOutcome, Verdict } from "../src/core/classify";

const CATEGORIES: SortCategory[] = [
  { name: "DESIGN", description: "graphics, typography, objects" },
  { name: "TECH", description: "code, software tools, hardware" },
];

const TAGS: SortCategory[] = [
  { name: "woodworking", description: "working wood" },
  { name: "diy", description: "making things yourself" },
];

describe("usableCategories", () => {
  it("keeps a well-formed list untouched", () => {
    expect(usableCategories(CATEGORIES)).toEqual(CATEGORIES);
  });

  it("drops an entry whose name is blank, which is a half-typed row", () => {
    const list = [...CATEGORIES, { name: "", description: "nothing yet" }];
    expect(usableCategories(list)).toEqual(CATEGORIES);
  });

  it("drops a name that is only whitespace", () => {
    const list = [...CATEGORIES, { name: "   ", description: "x" }];
    expect(usableCategories(list)).toEqual(CATEGORIES);
  });

  it("trims both fields, so a stray space cannot make a second category", () => {
    const list = [{ name: " DESIGN ", description: " graphics " }];
    expect(usableCategories(list)).toEqual([{ name: "DESIGN", description: "graphics" }]);
  });

  it("keeps the first of a duplicate name, because criteria is a map", () => {
    const list = [...CATEGORIES, { name: "DESIGN", description: "later" }];
    expect(usableCategories(list)).toEqual(CATEGORIES);
  });

  it("is empty for an empty list", () => {
    expect(usableCategories([])).toEqual([]);
  });
});

describe("buildSystemOneRequest", () => {
  it("asks one choice question over the categories", () => {
    const body = buildSystemOneRequest("a state", CATEGORIES, []);
    expect(body.state).toBe("a state");
    expect(body.questions.category).toEqual({
      type: "choice",
      instructions: "Which category is this web page about?",
      criteria: {
        DESIGN: "graphics, typography, objects",
        TECH: "code, software tools, hardware",
      },
    });
  });

  it("asks nothing else when no tags are declared", () => {
    const body = buildSystemOneRequest("a state", CATEGORIES, []);
    expect(Object.keys(body.questions)).toEqual(["category"]);
  });

  it("adds one noul per tag, prefixed so it cannot collide with category", () => {
    const tags: SortCategory[] = [
      { name: "woodworking", description: "working wood with tools" },
    ];
    const body = buildSystemOneRequest("a state", CATEGORIES, tags);
    expect(body.questions["tag:woodworking"]).toEqual({
      type: "noul",
      instructions: "This web page is about working wood with tools",
    });
  });

  it("falls back to the tag name when it has no description", () => {
    const tags: SortCategory[] = [{ name: "diy", description: "" }];
    const body = buildSystemOneRequest("a state", CATEGORIES, tags);
    expect(body.questions["tag:diy"].instructions).toBe("This web page is about diy");
  });

  it("falls back to the category name too, rather than sending an empty criterion", () => {
    // A description is optional in the settings. Sending "" would have the
    // model match the clipping against nothing, which is worse than matching
    // it against the word DESIGN.
    const bare: SortCategory[] = [{ name: "DESIGN", description: "" }];
    const body = buildSystemOneRequest("a state", bare, []);
    expect(body.questions.category.criteria).toEqual({ DESIGN: "DESIGN" });
  });
});

function answer(probabilities: Record<string, number>, confidence = 0.9): unknown {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { answers: { category: { type: "choice", choice, confidence, probabilities } } };
}

describe("readSystemOneResponse", () => {
  it("takes the winner when it clears the threshold", () => {
    const body = answer({ DESIGN: 0.91, TECH: 0.09 });
    expect(readSystemOneResponse(body, CATEGORIES, [], 0.6)).toEqual({
      category: "DESIGN",
      tags: [],
      probability: 0.91,
    });
  });

  it("decides nothing when the winner is below the threshold", () => {
    const body = answer({ DESIGN: 0.55, TECH: 0.45 });
    expect(readSystemOneResponse(body, CATEGORIES, [], 0.6).category).toBe("");
  });

  it("accepts a winner at exactly the threshold", () => {
    const body = answer({ DESIGN: 0.6, TECH: 0.4 });
    expect(readSystemOneResponse(body, CATEGORIES, [], 0.6).category).toBe("DESIGN");
  });

  it("sorts on probability even when entropy makes confidence low", () => {
    // Six categories spread thin: confidence is one minus normalised entropy,
    // so it collapses here while the winner is still clearly ahead. This is
    // the case the threshold must not reject.
    const body = answer({ DESIGN: 0.7, TECH: 0.06, A: 0.06, B: 0.06, C: 0.06, D: 0.06 }, 0.21);
    expect(readSystemOneResponse(body, CATEGORIES, [], 0.6).category).toBe("DESIGN");
  });

  it("refuses a category nobody declared", () => {
    const body = answer({ SPORTS: 0.99 });
    expect(readSystemOneResponse(body, CATEGORIES, [], 0.6).category).toBe("");
  });

  it("keeps tags at or above the threshold, in declaration order", () => {
    const body = {
      answers: {
        category: { type: "choice", choice: "DESIGN", probabilities: { DESIGN: 0.9 } },
        "tag:diy": { type: "noul", noul: 0.8 },
        "tag:woodworking": { type: "noul", noul: 0.95 },
      },
    };
    expect(readSystemOneResponse(body, CATEGORIES, TAGS, 0.6).tags).toEqual([
      "woodworking",
      "diy",
    ]);
  });

  it("drops a tag below the threshold", () => {
    const body = {
      answers: {
        category: { type: "choice", choice: "DESIGN", probabilities: { DESIGN: 0.9 } },
        "tag:woodworking": { type: "noul", noul: 0.2 },
        "tag:diy": { type: "noul", noul: 0.9 },
      },
    };
    expect(readSystemOneResponse(body, CATEGORIES, TAGS, 0.6).tags).toEqual(["diy"]);
  });

  it("survives a missing answer key", () => {
    expect(readSystemOneResponse({ answers: {} }, CATEGORIES, TAGS, 0.6)).toEqual({
      category: "",
      tags: [],
      probability: 0,
    });
  });

  it("survives a body that is not an object at all", () => {
    expect(readSystemOneResponse("nope", CATEGORIES, [], 0.6).category).toBe("");
    expect(readSystemOneResponse(null, CATEGORIES, [], 0.6).category).toBe("");
  });

  it("still returns tags when the category was refused", () => {
    const body = {
      answers: {
        category: { type: "choice", choice: "SPORTS", probabilities: { SPORTS: 0.99 } },
        "tag:diy": { type: "noul", noul: 0.9 },
      },
    };
    const verdict = readSystemOneResponse(body, CATEGORIES, TAGS, 0.6);
    expect(verdict.category).toBe("");
    expect(verdict.tags).toEqual(["diy"]);
  });
});

describe("buildLlmMessages", () => {
  it("names every declared category in the prompt", () => {
    const body = buildLlmMessages("a state", CATEGORIES, "gpt-4o-mini");
    const prompt = JSON.stringify(body.messages);
    expect(prompt).toContain("DESIGN");
    expect(prompt).toContain("graphics, typography, objects");
  });

  it("carries the model and asks for a JSON object", () => {
    const body = buildLlmMessages("a state", CATEGORIES, "gpt-4o-mini");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("lists a description-less category as a bare name, with no dangling colon", () => {
    const bare: SortCategory[] = [{ name: "DESIGN", description: "" }];
    const prompt = buildLlmMessages("a state", bare, "m").messages[0].content;
    expect(prompt).toContain("- DESIGN\n");
    expect(prompt).not.toContain("- DESIGN:");
  });

  it("puts the state in the user message, not the system one", () => {
    const body = buildLlmMessages("the clipping text", CATEGORIES, "m");
    expect(body.messages[1]).toEqual({ role: "user", content: "the clipping text" });
  });
});

describe("readLlmResponse", () => {
  it("reads a category and free tags", () => {
    const text = '{"category":"DESIGN","tags":["woodworking","clamps"]}';
    expect(readLlmResponse(text, CATEGORIES)).toEqual({
      category: "DESIGN",
      tags: ["woodworking", "clamps"],
      probability: 1,
    });
  });

  it("digs the object out of prose, which small models wrap it in", () => {
    const text = 'Here you go:\n```json\n{"category":"TECH","tags":[]}\n```';
    expect(readLlmResponse(text, CATEGORIES).category).toBe("TECH");
  });

  it("refuses a category nobody declared", () => {
    const text = '{"category":"SPORTS","tags":["running"]}';
    const verdict = readLlmResponse(text, CATEGORIES);
    expect(verdict.category).toBe("");
    expect(verdict.tags).toEqual(["running"]);
  });

  it("decides nothing when the reply is not JSON", () => {
    expect(readLlmResponse("I am afraid I cannot do that", CATEGORIES)).toEqual({
      category: "",
      tags: [],
      probability: 0,
    });
  });

  it("ignores tags that are not strings", () => {
    const text = '{"category":"DESIGN","tags":["ok",42,null,{"a":1}]}';
    expect(readLlmResponse(text, CATEGORIES).tags).toEqual(["ok"]);
  });

  it("tolerates a missing tags key", () => {
    expect(readLlmResponse('{"category":"DESIGN"}', CATEGORIES).tags).toEqual([]);
  });

  it("trims and drops blank tags", () => {
    const text = '{"category":"DESIGN","tags":["  spaced  ","","   "]}';
    expect(readLlmResponse(text, CATEGORIES).tags).toEqual(["spaced"]);
  });
});

const SORTED = { category: "DESIGN", tags: ["woodworking"], probability: 0.9 };
const UNSORTED = { category: "", tags: [], probability: 0 };

describe("verdictExtras", () => {
  it("writes categories and tags whatever the destination", () => {
    expect(verdictExtras(SORTED, "property")).toEqual({
      lines: ["categories:", '  - "DESIGN"'],
      tags: ["woodworking"],
    });
  });

  it("adds grid for the grid destination", () => {
    expect(verdictExtras(SORTED, "grid").lines).toEqual([
      "categories:",
      '  - "DESIGN"',
      'grid: "DESIGN"',
    ]);
  });

  it("adds folder for the folder destination", () => {
    expect(verdictExtras(SORTED, "folder").lines).toEqual([
      "categories:",
      '  - "DESIGN"',
      'folder: "DESIGN"',
    ]);
  });

  it("adds nothing extra for the subfolder destination, which moves the file", () => {
    expect(verdictExtras(SORTED, "subfolder").lines).toEqual(["categories:", '  - "DESIGN"']);
  });

  it("marks an undecided clipping instead of writing an empty category", () => {
    expect(verdictExtras(UNSORTED, "subfolder")).toEqual({
      lines: ["unsorted: true"],
      tags: [],
    });
  });

  it("still writes tags when only the category was undecided", () => {
    const verdict = { category: "", tags: ["diy"], probability: 0 };
    expect(verdictExtras(verdict, "property")).toEqual({
      lines: ["unsorted: true"],
      tags: ["diy"],
    });
  });

  it("escapes a quote in a category so the frontmatter still parses", () => {
    const verdict = { category: 'DE"SIGN', tags: [], probability: 0.9 };
    expect(verdictExtras(verdict, "property").lines).toEqual([
      "categories:",
      '  - "DE\\"SIGN"',
    ]);
  });
});

describe("verdictSubfolder", () => {
  it("names the category only for the subfolder destination", () => {
    expect(verdictSubfolder(SORTED, "subfolder")).toBe("DESIGN");
    expect(verdictSubfolder(SORTED, "grid")).toBe("");
    expect(verdictSubfolder(SORTED, "property")).toBe("");
  });

  it("is empty when nothing was decided", () => {
    expect(verdictSubfolder(UNSORTED, "subfolder")).toBe("");
  });
});

describe("clippingState", () => {
  it("sends the description alone, which measured 17 points better", () => {
    expect(clippingState("A title", "A description", "https://example.com")).toBe(
      "A description"
    );
  });

  it("drops the url, which names the platform and not the subject", () => {
    expect(clippingState("A title", "A description", "https://example.com")).not.toContain(
      "example.com"
    );
  });

  it("falls back to the title when a page declares no description", () => {
    expect(clippingState("A title", "", "https://example.com")).toBe("A title");
  });

  it("treats a whitespace-only description as absent", () => {
    expect(clippingState("A title", "   \n  ", "https://example.com")).toBe("A title");
  });

  it("is empty for a bare link, so it stays unsorted rather than filed on a domain", () => {
    expect(clippingState("", "", "https://www.threads.com/")).toBe("");
  });

  it("keeps the platform out of a social post that carries its own text", () => {
    const state = clippingState(
      "Jean-Luc Mélenchon (@jlmelenchon) on Threads",
      "Avis aux génies du gouvernement qui font semblant de ne pas savoir comment baisser les prix à la pompe.",
      "https://www.threads.com/share/GSl8zvm8L/"
    );
    expect(state).not.toContain("Threads");
    expect(state).toContain("gouvernement");
  });
});

describe("withFallback", () => {
  const MISC_LIST: SortCategory[] = [...CATEGORIES, { name: "MISC", description: "anything else" }];
  const answered = (outcome: SortOutcome, tags: string[] = []): Classification => ({
    verdict: { category: "", tags, probability: 0 },
    outcome,
  });

  it("files an unsure clipping under the fallback, and says it was the fallback", () => {
    const result = withFallback(answered("unsure"), "MISC", MISC_LIST);
    expect(result.verdict.category).toBe("MISC");
    expect(result.outcome).toBe("fallback");
  });

  it("keeps the tags the engine did agree on", () => {
    const result = withFallback(answered("unsure", ["lamp"]), "MISC", MISC_LIST);
    expect(result.verdict.tags).toEqual(["lamp"]);
  });

  it("reports no probability, because nothing measured this choice", () => {
    expect(withFallback(answered("unsure"), "MISC", MISC_LIST).verdict.probability).toBe(0);
  });

  it("leaves an unsure clipping unsorted when no fallback is chosen", () => {
    const result = withFallback(answered("unsure"), "", MISC_LIST);
    expect(result.verdict.category).toBe("");
    expect(result.outcome).toBe("unsure");
  });

  it("ignores a fallback that is no longer declared, as after a rename", () => {
    const result = withFallback(answered("unsure"), "MISC", CATEGORIES);
    expect(result.verdict.category).toBe("");
    expect(result.outcome).toBe("unsure");
  });

  it("matches the fallback through the same trimming the declarations get", () => {
    const list = [{ name: " MISC ", description: "" }];
    expect(withFallback(answered("unsure"), "MISC", list).verdict.category).toBe("MISC");
  });

  it.each(["unavailable", "no-text", "no-categories", "off"] as const)(
    "does not hide a %s outcome inside the fallback",
    (outcome) => {
      const result = withFallback(answered(outcome), "MISC", MISC_LIST);
      expect(result.verdict.category).toBe("");
      expect(result.outcome).toBe(outcome);
    }
  );

  it("leaves a sorted clipping exactly as it was", () => {
    const sorted: Classification = {
      verdict: { category: "DESIGN", tags: [], probability: 0.9 },
      outcome: "sorted",
    };
    expect(withFallback(sorted, "MISC", MISC_LIST)).toEqual(sorted);
  });
});

describe("destinationFields", () => {
  const decided = (category: string): Verdict => ({ category, tags: [], probability: 0.9 });

  it("writes only the categories for the property destination", () => {
    expect(destinationFields(decided("DESIGN"), "property")).toEqual({ categories: ["DESIGN"] });
  });

  it("writes only the categories for a subfolder: the move is the destination", () => {
    expect(destinationFields(decided("DESIGN"), "subfolder")).toEqual({ categories: ["DESIGN"] });
  });

  it("adds a grid of the same name for the grid destination", () => {
    expect(destinationFields(decided("DESIGN"), "grid")).toEqual({
      categories: ["DESIGN"],
      grid: "DESIGN",
    });
  });

  it("adds a folder of the same name for the folder destination", () => {
    expect(destinationFields(decided("DESIGN"), "folder")).toEqual({
      categories: ["DESIGN"],
      folder: "DESIGN",
    });
  });

  it.each(["property", "subfolder", "grid", "folder"] as const)(
    "decides nothing for an undecided verdict, even with the %s destination",
    (destination) => {
      expect(destinationFields(decided(""), destination)).toEqual({ categories: [] });
    }
  );

  it("returns a name with a quote raw, leaving the escaping to whoever writes YAML", () => {
    expect(destinationFields(decided('Say "hi"'), "grid")).toEqual({
      categories: ['Say "hi"'],
      grid: 'Say "hi"',
    });
  });
});
