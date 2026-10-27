/**
 * The pure half of finding what a Threads post is really about. Plenty of
 * posts carry only a teaser: the link they are for sits in the author's own
 * first reply, and the post's own preview picture is the author's avatar,
 * which makes a poor cover. The page that shows the reply is rendered in a
 * webview (see ../threads-link.ts); everything that decides, parses and
 * filters lives here, where it tests.
 */

/** One thing the loaded page shows, in the order it shows it. */
export type ThreadsItem =
  /** A post's header: the permalink to a post, with its author. */
  | { kind: "post"; user: string; code: string }
  /** An outbound link, exactly as the page wrote it. `image` is the card's picture. */
  | { kind: "link"; href: string; image: string | null };

export interface AuthorLink {
  /** The address the author's reply links to. */
  url: string;
  /** The picture Threads showed on the link's card, when it showed one. */
  image: string | null;
}

export type AuthorLinkRead = { decided: false } | { decided: true; link: AuthorLink | null };

/** Meta's own sites: a link into them is page furniture, never the author's point. */
const META_HOSTS = /(^|\.)(threads\.(com|net)|instagram\.com|facebook\.com|fb\.com|meta\.com)$/i;
const REDIRECT_HOSTS = new Set(["l.threads.com", "l.threads.net", "l.instagram.com"]);

function webUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The real address behind an outbound link. Threads wraps every one in a
 * redirect of its own, `l.threads.com/?u=<address>`, so the address is read
 * out of `u` rather than followed. Null for a link that leads back into
 * Meta's sites, or to nothing a browser could open.
 */
export function unwrapLink(href: string): string | null {
  const parsed = webUrl(href);
  if (!parsed) return null;

  let target: URL | null = parsed;
  if (REDIRECT_HOSTS.has(parsed.hostname.toLowerCase())) {
    const wrapped = parsed.searchParams.get("u");
    target = wrapped ? webUrl(wrapped) : null;
  }
  if (!target || META_HOSTS.test(target.hostname)) return null;
  return target.toString();
}

/**
 * The picture a link card shows, as an address worth downloading. Threads
 * serves it through its own image proxy, whose `url` parameter holds the
 * original: that is the page's own preview image, which stays where it is,
 * where the proxied copy is signed and expires.
 */
export function cardImageUrl(src: string): string | null {
  const parsed = webUrl(src);
  if (!parsed) return null;
  const original = parsed.searchParams.get("url");
  if (original !== null) return webUrl(original)?.toString() ?? null;
  return parsed.toString();
}

/**
 * Whether an Instagram CDN address is a profile picture. Their paths end the
 * asset type in `-19` (`t51.2885-19`, `t51.82787-19`), where a post's own
 * image says `-15`. A Threads post that shows no picture of its own falls
 * back to its author's, which is the cover this exists to replace.
 */
export function isThreadsAvatar(url: string): boolean {
  return /\/t51\.\d+-19\//.test(url);
}

/**
 * Whether a post's resolved media is nothing but profile pictures, or
 * nothing at all. Only then is the link in its author's reply worth looking
 * for: a post with a picture or a video of its own is covered by that.
 */
export function showsOnlyAvatar(media: Array<{ url: string; kind: "image" | "video" }>): boolean {
  return media.every((item) => item.kind === "image" && isThreadsAvatar(item.url));
}

interface Block {
  user: string;
  links: Array<Extract<ThreadsItem, { kind: "link" }>>;
}

/** The posts the page shows, each with the links that follow it, repeats folded in. */
function blocks(items: ThreadsItem[]): Block[] {
  const byCode = new Map<string, Block>();
  const out: Block[] = [];
  let current: Block | null = null;
  for (const item of items) {
    if (item.kind === "post") {
      let block = byCode.get(item.code);
      if (!block) {
        block = { user: item.user.toLowerCase(), links: [] };
        byCode.set(item.code, block);
        out.push(block);
      }
      current = block;
    } else {
      current?.links.push(item);
    }
  }
  return out;
}

/** The first usable link of a block, with the first picture any copy of it shows. */
function firstLink(block: Block): AuthorLink | null {
  let url: string | null = null;
  let image: string | null = null;
  for (const item of block.links) {
    const target = unwrapLink(item.href);
    if (!target) continue;
    url ??= target;
    if (target === url && image === null && item.image) image = cardImageUrl(item.image);
  }
  return url ? { url, image } : null;
}

/**
 * What the page says about the link behind a post.
 *
 * Only a post with no link of its own is worth looking past: one that has a
 * link keeps the picture it already has. Past it, only the author's first
 * reply counts. A reply from anyone else, or a later one, is a different
 * conversation.
 *
 * `decided: false` means the page has not shown enough yet, because replies
 * arrive after the post does. It is not an answer, and the caller waits.
 */
export function readAuthorLink(items: ThreadsItem[]): AuthorLinkRead {
  const [main, reply, after] = blocks(items);
  if (!main) return { decided: false };
  if (firstLink(main)) return { decided: true, link: null };
  if (!reply) return { decided: false };

  if (reply.user !== main.user) return { decided: true, link: null };
  const found = firstLink(reply);
  if (found) return { decided: true, link: found };
  // The reply is the last thing shown: its link card may still be on its way.
  return after ? { decided: true, link: null } : { decided: false };
}

/**
 * Runs inside the loaded page and reports what it shows, in order: every
 * post header and every outbound link, as JSON for `items`. A post header is
 * a permalink that wraps a `<time>`, which is also what tells it from the
 * "Thread" link on the post itself. A cookie dialog is skipped, since its
 * links are Meta's. A string because it is evaluated in another process, so
 * it names nothing from this module.
 */
export const THREADS_PROBE = `(() => {
  const items = [];
  const nodes = document.querySelectorAll(
    'time, a[href^="https://l.threads.com/"], a[href^="https://l.threads.net/"], a[href^="https://l.instagram.com/"]'
  );
  for (const el of nodes) {
    if (el.closest('[role="dialog"]')) continue;
    if (el.tagName === "TIME") {
      const a = el.closest("a[href]");
      const m = a && /^\\/@([^/]+)\\/post\\/([^/?#]+)/.exec(new URL(a.href).pathname);
      if (m) items.push({ kind: "post", user: decodeURIComponent(m[1]), code: m[2] });
      continue;
    }
    let image = null;
    let widest = 99;
    for (const img of el.querySelectorAll("img")) {
      const width = img.naturalWidth || img.width;
      if (width > widest && img.src) {
        widest = width;
        image = img.src;
      }
    }
    items.push({ kind: "link", href: el.href, image });
  }
  return JSON.stringify(items);
})();`;

/** Reads the probe's answer; anything that is not a list of items reads as none. */
export function parseProbe(raw: unknown): ThreadsItem[] {
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const items: ThreadsItem[] = [];
  for (const entry of data as Array<Record<string, unknown>>) {
    if (entry?.kind === "post" && typeof entry.user === "string" && typeof entry.code === "string") {
      items.push({ kind: "post", user: entry.user, code: entry.code });
    } else if (entry?.kind === "link" && typeof entry.href === "string") {
      items.push({
        kind: "link",
        href: entry.href,
        image: typeof entry.image === "string" ? entry.image : null,
      });
    }
  }
  return items;
}
