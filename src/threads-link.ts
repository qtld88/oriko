import { Platform } from "obsidian";
import { THREADS_PROBE, parseProbe, readAuthorLink } from "./core/threads-link";
import type { AuthorLink } from "./core/threads-link";

/**
 * Finds the link a Threads post is really about by loading the post, the way
 * sniff.ts finds its video. The post's own page publishes nothing a plain
 * request can read: its replies, and the link in the author's first one,
 * exist only once the page's scripts have rendered them. A hidden webview is
 * a real visit, signed out or signed in as the user's own session is, with
 * nothing impersonated and no third party in the path.
 *
 * Desktop only: the webview tag is Electron's.
 */

/** The longest a page gets to show its replies before the answer is none. */
const TIMEOUT_MS = 15000;
const POLL_MS = 600;
/**
 * Polls with nothing new on the page, after which it is taken to be done. A
 * post with no replies never reaches a decision of its own, and without
 * this it would pay the whole timeout.
 */
const QUIET_POLLS = 5;

/** The slice of Electron's webview element this module touches. */
interface WebviewLike extends HTMLElement {
  executeJavaScript(script: string): Promise<unknown>;
}

export async function findAuthorLink(pageUrl: string): Promise<AuthorLink | null> {
  if (!Platform.isDesktopApp) return null;

  const view = createEl("webview" as keyof HTMLElementTagNameMap) as WebviewLike;
  view.setAttribute("src", pageUrl);
  // Rendered but out of sight, for the reason sniff.ts gives.
  view.classList.add("pg-sniff-frame");
  document.body.appendChild(view);

  try {
    return await new Promise<AuthorLink | null>((resolve) => {
      let done = false;
      let poll = 0;
      let shown = 0;
      let quiet = 0;
      let lastAnswer: string | null = null;
      const finish = (value: AuthorLink | null): void => {
        if (done) return;
        done = true;
        window.clearInterval(poll);
        window.clearTimeout(timer);
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), TIMEOUT_MS);

      view.addEventListener("dom-ready", () => {
        poll = window.setInterval(() => {
          void (async () => {
            try {
              const items = parseProbe(await view.executeJavaScript(THREADS_PROBE));
              const read = readAuthorLink(items);
              if (read.decided) {
                // Taken only once two polls in a row agree: a post's player
                // mounts a moment after its replies appear, and a post with
                // a video must not be settled on the link beneath it.
                const answer = JSON.stringify(read.link);
                if (answer === lastAnswer) return finish(read.link);
                lastAnswer = answer;
                return;
              }
              lastAnswer = null;
              quiet = items.length > 0 && items.length === shown ? quiet + 1 : 0;
              shown = items.length;
              if (quiet >= QUIET_POLLS) finish(null);
            } catch {
              // Probe landed between navigations; the next tick retries.
            }
          })();
        }, POLL_MS);
      });
      view.addEventListener("did-fail-load", () => finish(null));
    });
  } finally {
    view.remove();
  }
}
