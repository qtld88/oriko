/**
 * Handing archived files to the host's share sheet.
 *
 * The desktop export copies into ~/Downloads through node's fs, which mobile
 * does not have. iOS does not have a Downloads folder an app may write to
 * either, so the equivalent there is the share sheet: the bytes go to the
 * system, and the user picks Save Image or Save to Files. That makes the
 * destination theirs rather than ours, which is the only shape "save to
 * device" can take inside a sandboxed app.
 *
 * Pure, in `core/`, and given its host rather than reaching for `navigator`:
 * the whole point of the file is deciding what to do when the host answers
 * in one of several unhelpful ways, and that is only testable if the host
 * can be faked.
 */

/** The slice of `navigator` this needs, absent on hosts without Web Share. */
export interface ShareHost {
  canShare?: (data: { files?: File[] }) => boolean;
  share?: (data: { files?: File[] }) => Promise<void>;
}

export interface ShareItem {
  /** Filename as it should arrive on the device, extension included. */
  name: string;
  mime: string;
  data: ArrayBuffer;
}

export interface ShareDeps {
  host: ShareHost | undefined;
  /** Injected so a test needs no File constructor and no DOM. */
  makeFile: (data: ArrayBuffer, name: string, mime: string) => File;
}

export type ShareOutcome =
  /** The sheet came up and the user saw it through. */
  | "shared"
  /** The sheet came up and the user dismissed it. Not a failure. */
  | "cancelled"
  /** No Web Share, or it refused these files. Nothing was offered. */
  | "unsupported"
  /**
   * The host would not treat this as a user gesture.
   *
   * Its own outcome because it is the one plausible way this fails on a
   * device that supports everything else: WebKit only shares inside a live
   * user activation, and reading the file off the vault is an await between
   * the tap and the call. The read is a local file and returns in
   * milliseconds, comfortably inside the activation window, but "comfortably"
   * is not "certainly", and a device test that hits this should say so rather
   * than blame the file.
   */
  | "blocked"
  /** It was offered and threw for some other reason. */
  | "failed"
  /** Nothing archived to share in the first place. */
  | "empty";

/**
 * Whether the host can share files at all.
 *
 * Both halves are required. A host with `share` but no `canShare` is a Web
 * Share level 1 implementation, which takes a URL and text and throws on
 * files, so offering the button there would promise something that cannot
 * work. Checked before any bytes are read, so a desktop build never loads a
 * video into memory to find out.
 */
export function canShareFiles(host: ShareHost | undefined): boolean {
  return typeof host?.share === "function" && typeof host?.canShare === "function";
}

/** A dismissed share sheet, which every browser reports as an AbortError. */
function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** A share refused for want of a live user gesture. */
function isBlocked(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}

/**
 * Offers every file in one sheet, so a clipping with a video and three
 * pictures is one prompt rather than four.
 *
 * `canShare` is asked with the real files rather than a probe, because what
 * it rejects is the specific set: iOS refuses some types outright and refuses
 * a large batch on size, and both answers depend on what is actually being
 * sent.
 */
export async function shareFiles(deps: ShareDeps, items: ShareItem[]): Promise<ShareOutcome> {
  if (items.length === 0) return "empty";
  const { host, makeFile } = deps;
  if (!canShareFiles(host) || !host?.share || !host.canShare) return "unsupported";

  const files = items.map((item) => makeFile(item.data, item.name, item.mime));
  if (!host.canShare({ files })) return "unsupported";

  try {
    await host.share({ files });
    return "shared";
  } catch (error) {
    if (isCancellation(error)) return "cancelled";
    return isBlocked(error) ? "blocked" : "failed";
  }
}

/**
 * What to tell the user, or null when the outcome speaks for itself.
 *
 * A cancelled sheet says nothing: the user closed it, they know. A shared one
 * says nothing either, because the share sheet is its own confirmation and
 * the destination was the system's to report, not ours - we are not told
 * whether they saved it or sent it to someone.
 */
export function shareNotice(outcome: ShareOutcome): string | null {
  switch (outcome) {
    case "shared":
    case "cancelled":
      return null;
    case "empty":
      return "Oriko: nothing archived to save yet";
    case "unsupported":
      return "Oriko: this device cannot save files out of Obsidian";
    case "blocked":
      return "Oriko: tap Save to device again - the file was still loading";
    case "failed":
      return "Oriko: could not save the file";
  }
}
