import { noteFilePrefix } from "./archive";
import { hashUrl } from "./hash";

/**
 * Renaming media that predates note-named files, so an existing vault reads
 * the way a fresh clip now does: `<note name> <12 hex>.<ext>`.
 *
 * Pure: told which note uses which files and which files the plugin made,
 * it answers what to rename to what. The Obsidian half moves the files and
 * rewrites the links.
 */

export interface NoteMedia {
  /** Vault path of the note. */
  path: string;
  /** Vault paths of the originals it uses, derived stills excluded. */
  files: readonly string[];
}

export interface Rename {
  note: string;
  from: string;
  to: string;
}

/** `<12 hex>-<rest>`: the older archived name, whose hash is kept. */
const ARCHIVED = /^([0-9a-f]{12})-(.+)$/;
/** `<note name> <12 hex>.<ext>`: already note-named, perhaps for an older name. */
const NAMED = /^(.+) ([0-9a-f]{12})\.[^.]+$/;

function split(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, slash), name: path.slice(slash + 1) };
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function noteName(path: string): string {
  return split(path).name.replace(/\.md$/i, "");
}

/**
 * The hash a file's new name carries. An archived file keeps the one it has,
 * because the archiver finds a file by that hash; a paste or a scan has none
 * and gets one from its own path.
 */
function hashOf(name: string, path: string): string {
  return ARCHIVED.exec(name)?.[1] ?? NAMED.exec(name)?.[2] ?? hashUrl(path);
}

/**
 * What to rename. A file two notes share keeps its name, since it cannot
 * carry both; so does a file the plugin did not make, or one already named
 * right. `taken` guards against landing on a file that exists.
 */
export function planRenames(
  notes: readonly NoteMedia[],
  shared: (file: string) => boolean,
  owned: (file: string) => boolean,
  taken: (path: string) => boolean
): Rename[] {
  const renames: Rename[] = [];
  const claimed = new Set<string>();

  for (const note of notes) {
    const prefix = noteFilePrefix(noteName(note.path));
    if (!prefix) continue;

    for (const from of new Set(note.files)) {
      if (shared(from) || !owned(from)) continue;
      const { folder, name } = split(from);
      const ext = extension(name);
      if (!ext) continue;

      const base = `${prefix} ${hashOf(name, from)}`;
      const at = (n: number): string => {
        const file = n < 2 ? `${base}.${ext}` : `${base} ${n}.${ext}`;
        return folder ? `${folder}/${file}` : file;
      };
      if (at(1) === from) continue;

      let to = at(1);
      for (let n = 2; claimed.has(to) || taken(to); n++) to = at(n);
      claimed.add(to);
      renames.push({ note: note.path, from, to });
    }
  }

  return renames;
}

const DERIVED = [".thumb.webp", ".poster.webp", ".preview.png"];

/** The stills generated from an original, renamed along with it. */
export function derivedRenames(from: string, to: string): Array<{ from: string; to: string }> {
  const strip = (path: string): string => {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    return dot > slash ? path.slice(0, dot) : path;
  };
  return DERIVED.map((suffix) => ({ from: strip(from) + suffix, to: strip(to) + suffix }));
}

/**
 * The note's text with every reference to the old file pointed at the new
 * one. Wikilinks and the cover property take the name as is; a markdown
 * link cannot hold a space, so there it is percent-encoded.
 */
export function relink(content: string, from: string, to: string): string {
  const oldName = split(from).name;
  const newName = split(to).name;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const encoded = newName.replace(/ /g, "%20");
  return content
    .replace(new RegExp(`(\\]\\(<?[^)\\s]*?)${escaped}(>?\\))`, "g"), `$1${encoded}$2`)
    .split(oldName)
    .join(newName);
}
