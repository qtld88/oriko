import { describe, expect, it } from "vitest";
import {
  cardImageUrl,
  parseProbe,
  readAuthorLink,
  showsOnlyAvatar,
  unwrapLink,
} from "../src/core/threads-link";
import type { ThreadsItem } from "../src/core/threads-link";

const post = (user: string, code: string): ThreadsItem => ({ kind: "post", user, code });
const link = (href: string, image: string | null = null): ThreadsItem => ({
  kind: "link",
  href,
  image,
});
const wrapped = (target: string): string =>
  `https://l.threads.com/?u=${encodeURIComponent(target)}&e=AUB7bJ8F`;

describe("unwrapLink", () => {
  it("reads the real address out of a Threads redirect", () => {
    expect(unwrapLink(wrapped("https://octostudio.org/"))).toBe("https://octostudio.org/");
  });

  it("keeps the query string of the real address", () => {
    expect(unwrapLink(wrapped("https://e.com/a?id=3&x=1"))).toBe("https://e.com/a?id=3&x=1");
  });

  it("reads an Instagram redirect the same way", () => {
    const href = `https://l.instagram.com/?u=${encodeURIComponent("https://e.com/")}&e=x`;
    expect(unwrapLink(href)).toBe("https://e.com/");
  });

  it("passes a plain external address through", () => {
    expect(unwrapLink("https://e.com/page")).toBe("https://e.com/page");
  });

  it("drops a link back into Meta's own sites", () => {
    expect(unwrapLink(wrapped("https://www.facebook.com/help/1561485474074139"))).toBeNull();
    expect(unwrapLink(wrapped("https://help.instagram.com/515230437301944"))).toBeNull();
    expect(unwrapLink("https://www.threads.com/@a/post/B")).toBeNull();
    expect(unwrapLink(wrapped("https://www.threads.net/@a"))).toBeNull();
  });

  it("drops a redirect with no target and anything that is not a web address", () => {
    expect(unwrapLink("https://l.threads.com/?e=x")).toBeNull();
    expect(unwrapLink(wrapped("javascript:alert(1)"))).toBeNull();
    expect(unwrapLink("not a url")).toBeNull();
  });
});

describe("cardImageUrl", () => {
  it("takes the original image out of Threads' image proxy", () => {
    const proxied =
      "https://external-bru2-1.xx.fbcdn.net/emg1/v/t13/2649967236578265161?url=" +
      encodeURIComponent("https://octostudio.org/images/hero.png") +
      "&utld=octostudio.org&stp=d";
    expect(cardImageUrl(proxied)).toBe("https://octostudio.org/images/hero.png");
  });

  it("keeps an image that is not behind the proxy", () => {
    expect(cardImageUrl("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
  });

  it("gives nothing for an empty or unusable source", () => {
    expect(cardImageUrl("")).toBeNull();
    expect(cardImageUrl("data:image/gif;base64,R0lGOD")).toBeNull();
    expect(cardImageUrl("https://external.fbcdn.net/x?url=javascript%3Aalert(1)")).toBeNull();
  });
});

describe("showsOnlyAvatar", () => {
  const avatar = "https://scontent.cdninstagram.com/v/t51.2885-19/4718_n.jpg";
  const photo = "https://scontent.cdninstagram.com/v/t51.2885-15/6491_n.jpg";

  it("is true for a post that offers only the author's avatar", () => {
    expect(showsOnlyAvatar([{ url: avatar, kind: "image" }])).toBe(true);
  });

  it("is true for a post that offers nothing", () => {
    expect(showsOnlyAvatar([])).toBe(true);
  });

  it("is false once the post has a picture of its own", () => {
    expect(showsOnlyAvatar([{ url: photo, kind: "image" }])).toBe(false);
    expect(
      showsOnlyAvatar([
        { url: avatar, kind: "image" },
        { url: photo, kind: "image" },
      ])
    ).toBe(false);
  });

  it("is false when the post has a video", () => {
    expect(showsOnlyAvatar([{ url: "https://cdn.example.com/a.mp4", kind: "video" }])).toBe(false);
  });
});

describe("parseProbe", () => {
  it("reads the items the page reported", () => {
    const items: ThreadsItem[] = [
      { kind: "post", user: "figi", code: "A" },
      { kind: "link", href: "https://l.threads.com/?u=x", image: "https://i.example/x.png" },
      { kind: "link", href: "https://l.threads.com/?u=y", image: null },
    ];
    expect(parseProbe(JSON.stringify(items))).toEqual(items);
  });

  it("drops entries that are not what the probe writes", () => {
    const raw = JSON.stringify([{ kind: "post", user: 3 }, null, { kind: "link" }, "x"]);
    expect(parseProbe(raw)).toEqual([]);
  });

  it("reads anything that is not a list as none", () => {
    expect(parseProbe("not json")).toEqual([]);
    expect(parseProbe('{"kind":"post"}')).toEqual([]);
    expect(parseProbe(undefined)).toEqual([]);
  });
});

describe("readAuthorLink", () => {
  it("waits while the page has shown nothing yet", () => {
    expect(readAuthorLink([])).toEqual({ decided: false });
  });

  it("finds the link in the author's first reply", () => {
    const items = [
      post("figi", "A"),
      post("figi", "B"),
      link(wrapped("https://octostudio.org/")),
      link(wrapped("https://octostudio.org/"), "https://octostudio.org/hero.png"),
      post("kitty", "C"),
    ];
    expect(readAuthorLink(items)).toEqual({
      decided: true,
      link: { url: "https://octostudio.org/", image: "https://octostudio.org/hero.png" },
    });
  });

  it("takes the card's image even when it follows the plain domain link", () => {
    const items = [
      post("figi", "A"),
      post("figi", "B"),
      link(wrapped("https://e.com/")),
      link(wrapped("https://other.com/"), "https://other.com/x.png"),
      link(wrapped("https://e.com/"), "https://e.com/x.png"),
      post("kitty", "C"),
    ];
    expect(readAuthorLink(items)).toEqual({
      decided: true,
      link: { url: "https://e.com/", image: "https://e.com/x.png" },
    });
  });

  it("leaves the image empty when the card shows none", () => {
    const items = [post("figi", "A"), post("figi", "B"), link(wrapped("https://e.com/")), post("k", "C")];
    expect(readAuthorLink(items)).toEqual({
      decided: true,
      link: { url: "https://e.com/", image: null },
    });
  });

  it("does nothing when the post itself carries the link", () => {
    const items = [
      post("figi", "A"),
      link(wrapped("https://e.com/")),
      post("figi", "B"),
      link(wrapped("https://other.com/")),
      post("k", "C"),
    ];
    expect(readAuthorLink(items)).toEqual({ decided: true, link: null });
  });

  it("does nothing when the first reply is someone else's", () => {
    const items = [
      post("figi", "A"),
      post("kitty", "B"),
      link(wrapped("https://e.com/")),
      post("figi", "C"),
      link(wrapped("https://other.com/")),
    ];
    expect(readAuthorLink(items)).toEqual({ decided: true, link: null });
  });

  it("does nothing when the author's first reply has no link", () => {
    const items = [post("figi", "A"), post("figi", "B"), post("kitty", "C")];
    expect(readAuthorLink(items)).toEqual({ decided: true, link: null });
  });

  it("ignores links into Meta's own sites", () => {
    const items = [
      post("figi", "A"),
      post("figi", "B"),
      link(wrapped("https://www.facebook.com/privacy/policy/")),
      link(wrapped("https://e.com/"), "https://e.com/x.png"),
      post("kitty", "C"),
    ];
    expect(readAuthorLink(items)).toEqual({
      decided: true,
      link: { url: "https://e.com/", image: "https://e.com/x.png" },
    });
  });

  it("matches the author without regard to case", () => {
    const items = [post("Figi", "A"), post("figi", "B"), link(wrapped("https://e.com/")), post("k", "C")];
    expect(readAuthorLink(items).decided).toBe(true);
    expect(readAuthorLink(items)).toMatchObject({ link: { url: "https://e.com/" } });
  });

  it("waits while only the post has rendered and it shows no link", () => {
    expect(readAuthorLink([post("figi", "A")])).toEqual({ decided: false });
  });

  it("decides on a link as soon as the reply has one, without waiting for a next post", () => {
    const items = [post("figi", "A"), post("figi", "B"), link(wrapped("https://e.com/"))];
    expect(readAuthorLink(items)).toEqual({
      decided: true,
      link: { url: "https://e.com/", image: null },
    });
  });

  it("waits while the author's first reply is the last thing shown and has no link yet", () => {
    expect(readAuthorLink([post("figi", "A"), post("figi", "B")])).toEqual({ decided: false });
  });

  it("keeps the links under a repeated header with the post it repeats", () => {
    const items = [
      post("figi", "A"),
      post("figi", "B"),
      post("figi", "B"),
      link(wrapped("https://e.com/")),
      post("k", "C"),
    ];
    expect(readAuthorLink(items)).toMatchObject({ decided: true, link: { url: "https://e.com/" } });
  });

  it("counts a post once however many times the page repeats it", () => {
    const items = [
      post("figi", "A"),
      post("figi", "A"),
      post("figi", "B"),
      link(wrapped("https://e.com/")),
      post("k", "C"),
    ];
    expect(readAuthorLink(items)).toMatchObject({ decided: true, link: { url: "https://e.com/" } });
  });
});
