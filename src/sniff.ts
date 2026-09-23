import { Platform } from "obsidian";
import {
  NO_SNIFF_PROGRESS,
  advanceSniff,
  pickSniffedVideo,
  sniffGivesUp,
} from "./core/resolve";
import type { SniffProbe } from "./core/resolve";

/**
 * Finds a post's video URL by actually loading the page, for hosts that
 * hide it from every server-side route. Threads publishes no og:video, no
 * inline JSON, and has no yt-dlp extractor: the video URL exists only after
 * the page's own scripts fetch it. A hidden webview is a real browser
 * visit — the same load a person makes before clicking "Copy video
 * address" — with no impersonation and no third party in the path.
 *
 * Desktop only: the webview tag is Electron's, and the mobile app archives
 * the poster now and adopts the video the desktop later syncs back.
 */

/** The slice of Electron's webview element this module touches. */
interface WebviewLike extends HTMLElement {
  executeJavaScript(script: string): Promise<unknown>;
}

/**
 * Runs inside the loaded page. Nudges the player, because the video URL
 * only hits the network once playback is attempted, then reports the
 * <video> source and every URL the page has requested so far — resource
 * timing sees the media fetch even when the element hides behind a blob.
 *
 * Whether a player exists at all is reported too. That is what tells a post
 * still fetching its video from a post that never had one.
 */
const PROBE = `(() => {
  const v = document.querySelector("video");
  if (v) {
    try {
      v.muted = true;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  const res = performance.getEntriesByType("resource").map((e) => e.name);
  return JSON.stringify({
    src: v ? v.currentSrc || v.src || "" : "",
    res,
    hasVideo: Boolean(v),
    ready: document.readyState === "complete",
  });
})();`;

const POLL_MS = 600;

export async function sniffVideoUrl(pageUrl: string, timeoutMs = 20000): Promise<string | null> {
  if (!Platform.isDesktopApp) return null;

  const view = createEl("webview" as keyof HTMLElementTagNameMap) as WebviewLike;
  view.setAttribute("src", pageUrl);
  // Rendered but out of sight (see .pg-sniff-frame): display:none or a
  // zero-size frame may never lay the player out, and a player that never
  // mounts never fetches.
  view.classList.add("pg-sniff-frame");
  document.body.appendChild(view);

  try {
    return await new Promise<string | null>((resolve) => {
      let done = false;
      let poll = 0;
      const finish = (value: string | null): void => {
        if (done) return;
        done = true;
        window.clearInterval(poll);
        window.clearTimeout(timer);
        resolve(value);
      };
      // The backstop, not the usual exit: a page that never loads, a
      // disabled webview tag, or a login wall all end here, never hang. A
      // post that simply has no video gives up long before this.
      const timer = window.setTimeout(() => finish(null), timeoutMs);

      let progress = NO_SNIFF_PROGRESS;
      view.addEventListener("dom-ready", () => {
        poll = window.setInterval(() => {
          void (async () => {
            try {
              const raw = await view.executeJavaScript(PROBE);
              const report = JSON.parse(String(raw)) as SniffProbe;
              const url = pickSniffedVideo([report.src, ...report.res]);
              if (url) return finish(url);
              // A loaded page that keeps showing no player has no video to
              // wait for. Without this the timeout is the only exit, and
              // every picture post pays it in full.
              progress = advanceSniff(progress, report);
              if (sniffGivesUp(progress)) finish(null);
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
