import { describe, expect, it } from "vitest";
import { decodeEntities, readMetaTags } from "../src/core/page-cover";

describe("decodeEntities", () => {
  it("decodes a hex reference, which is what Threads writes a French title with", () => {
    expect(decodeEntities("Avis aux g&#xe9;nies")).toBe("Avis aux génies");
  });

  it("decodes a decimal reference", () => {
    expect(decodeEntities("g&#233;nies")).toBe("génies");
  });

  it("accepts an uppercase X in a hex reference", () => {
    expect(decodeEntities("g&#Xe9;nies")).toBe("génies");
  });

  it("composes a decoded combining accent onto the letter before it", () => {
    expect(decodeEntities("Me&#x301;lenchon")).toBe("Mélenchon");
    expect(decodeEntities("Me&#x301;lenchon")).toHaveLength(9);
  });

  it("decodes an entity outside the basic plane", () => {
    expect(decodeEntities("ok &#128512;")).toBe("ok 😀");
  });

  it("still decodes the names it always did", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      "a & b <c> \"d\" 'e'"
    );
  });

  it("decodes an accented name", () => {
    expect(decodeEntities("caf&eacute; &Eacute;ric")).toBe("café Éric");
  });

  it("decodes typographic punctuation", () => {
    expect(decodeEntities("it&rsquo;s &mdash; fine&hellip;")).toBe("it’s — fine…");
  });

  it("decodes a non-breaking space to one, not to a plain space", () => {
    expect(decodeEntities("10&nbsp;%")).toBe("10 %");
  });

  it("does not decode its own output twice", () => {
    expect(decodeEntities("&amp;quot;")).toBe("&quot;");
    expect(decodeEntities("&amp;#233;")).toBe("&#233;");
  });

  it("leaves an unknown name standing rather than guessing", () => {
    expect(decodeEntities("a &notanentity; b")).toBe("a &notanentity; b");
  });

  it("leaves a lone surrogate alone, which has no character to become", () => {
    expect(decodeEntities("a &#xd800; b")).toBe("a &#xd800; b");
  });

  it("leaves a code point past the last plane alone", () => {
    expect(decodeEntities("a &#x110000; b")).toBe("a &#x110000; b");
  });

  it("leaves text with no entity untouched", () => {
    expect(decodeEntities("Mélenchon on Threads")).toBe("Mélenchon on Threads");
  });
});

describe("readMetaTags", () => {
  it("decodes the content it collects", () => {
    const html = '<meta property="og:title" content="Avis aux g&#xe9;nies">';
    expect(readMetaTags(html).get("og:title")).toBe("Avis aux génies");
  });
});
