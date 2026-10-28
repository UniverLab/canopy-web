// SPDX-License-Identifier: Apache-2.0
/**
 * One repository's catalogue content, taken in a single GitHub request.
 *
 * graphs.univerlab.org runs on the Workers Free plan, where one invocation
 * may spend 50 subrequests and a Cache API lookup or store counts as one.
 * Reading a folder-per-document repository over REST costs two or three
 * calls per folder — the listing, the document, the README — which is how
 * a scheduled run used to stop halfway through the official repository.
 * GitHub's GraphQL API answers the whole folder tree in one POST, so this
 * module asks for exactly that: the three top-level folders (`graphs/`,
 * `nodes/`, `patterns/`) and `blocked.json`, three entry levels deep, with
 * every blob's text.
 *
 * What comes back is decoded into the same shapes the REST path builds:
 * `snapshotSources` yields one document folder per slug, `patternsOfSnapshot`
 * yields the pattern cards and their stored pages, and both hand their texts
 * to the shared parsers in `documents.ts` and `patterns.ts`. Only the
 * transport differs, so a document reads identically either way.
 *
 * A partial answer never fails silently: a `errors` array on a folder whose
 * document file did not arrive marks that document `graphql error`, a missing
 * blob marks it `missing file`, and a blob with no text — binary or over the
 * API's size limit — marks it `blob not text`. A miss at the root (no tree
 * at all) is a repository that could not be read: the caller carries the
 * previous entries over instead of emptying it.
 */
import { type BlockedEntry, parseBlockedList } from "./blocked.js";
import {
  type DocumentLoad,
  type DocumentSource,
  documentDirectory,
  documentFile,
  documentFromTexts,
  toDateOnly,
} from "./documents.js";
import type { ApiError, GitHub, GraphQLResult, Log } from "./github.js";
import { isApiError } from "./github.js";
import { isArray, isNumber, isRecord, isString, stringField } from "./json.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO, OFFICIAL_REPOSITORY, SLUG_RE } from "./lib.js";
import {
  type PatternEntry,
  type PatternsRead,
  type StoredPattern,
  patternFromTexts,
} from "./patterns.js";
import type { IndexInvalid } from "./store.js";

/**
 * The one query the catalogue makes: the repository's accounting, its
 * default branch, and the tree at `HEAD:` three levels deep — the folders,
 * their document folders, and the files inside those. Nothing outside the
 * three folders is requested, so a repository's other content costs no
 * bandwidth.
 */
export const REPOSITORY_QUERY = `query RepositoryCatalogue($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount
    updatedAt
    defaultBranchRef { name }
    object(expression: "HEAD:") {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Blob { text }
            ... on Tree {
              entries {
                name
                type
                object {
                  ... on Blob { text }
                  ... on Tree {
                    entries {
                      name
                      type
                      object {
                        ... on Blob { text }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** The folders the index reads; nothing else is asked for. */
export const SNAPSHOT_DIRS = ["graphs", "nodes", "patterns"] as const;

/** The removal list's path at the repository root. */
export const BLOCKED_FILE = "blocked.json";

/** One blob in the tree: its name and the text GitHub returned for it. */
export interface SnapshotFile {
  name: string;
  /** The text; null when the blob is binary or past the API's size limit. */
  text: string | null;
  /** False when the entry came back without an object at all. */
  present: boolean;
}

/** One level of the tree: its files, and the folders beneath it. */
export interface SnapshotDir {
  files: Map<string, SnapshotFile>;
  dirs: Map<string, SnapshotDir>;
}

/** One repository as one GraphQL answer describes it. */
export interface Snapshot {
  stars: number | null;
  updated: string | null;
  branch: string;
  /** The root tree at `HEAD:`; null when the answer carried none. */
  tree: SnapshotDir | null;
  /** The `errors[].message` lines; empty when the query answered cleanly. */
  errors: string[];
}

/** Decode one level of `entries`, recursing into the subtrees asked for. */
function dirOf(entries: unknown): SnapshotDir {
  const dir: SnapshotDir = { files: new Map(), dirs: new Map() };
  if (!isArray(entries)) {
    return dir;
  }
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = stringField(entry, "name");
    if (name === "") {
      continue;
    }
    const object = entry["object"];
    if (isRecord(object) && isArray(object["entries"])) {
      dir.dirs.set(name, dirOf(object["entries"]));
      continue;
    }
    if (isRecord(object) && "text" in object) {
      dir.files.set(name, {
        name,
        text: isString(object["text"]) ? object["text"] : null,
        present: true,
      });
      continue;
    }
    // The entry exists but the answer carried no object for it: unreadable,
    // not absent, so the caller reports `missing file` rather than a miss.
    dir.files.set(name, { name, text: null, present: false });
  }
  return dir;
}

/** Turn one GraphQL answer into the snapshot the index reads. Never throws. */
export function snapshotOf(result: GraphQLResult): Snapshot {
  const data = isRecord(result.data) ? result.data : {};
  const repository = isRecord(data["repository"]) ? data["repository"] : null;
  if (repository === null) {
    return { stars: null, updated: null, branch: "", tree: null, errors: result.errors };
  }
  const root = repository["object"];
  const branch = repository["defaultBranchRef"];
  return {
    stars: isNumber(repository["stargazerCount"]) ? repository["stargazerCount"] : null,
    updated: toDateOnly(repository["updatedAt"]),
    branch: isRecord(branch) ? stringField(branch, "name") : "",
    tree: isRecord(root) && isArray(root["entries"]) ? dirOf(root["entries"]) : null,
    errors: result.errors,
  };
}

/** Ask GitHub for one repository's catalogue. One subrequest, never cached. */
export async function fetchSnapshot(
  github: GitHub,
  owner: string,
  repo: string,
  log: Log,
): Promise<Snapshot | ApiError> {
  const result = await github.graphql(REPOSITORY_QUERY, { owner, name: repo });
  if (isApiError(result)) {
    return result;
  }
  const snapshot = snapshotOf(result);
  for (const message of snapshot.errors) {
    log(`snapshot: ${owner}/${repo} answered an error: ${message}`);
  }
  return snapshot;
}

/** One document folder the snapshot listed, with the texts it carried. */
export interface SnapshotSource {
  source: DocumentSource;
  /** The document file's text, or null when it was not readable. */
  document: string | null;
  /** Why the document file has no text: `missing file`, `blob not text`, `graphql error`. */
  reason: string | null;
  /** The README's text, or null when the folder holds none. */
  readme: string | null;
}

/** Why one named file has no text, or null when it has one. */
function reasonFor(file: SnapshotFile | undefined, partial: boolean): string | null {
  if (file === undefined || !file.present) {
    // A partial answer may simply have dropped the entry; say so instead of
    // claiming the file is gone.
    return partial ? "graphql error" : "missing file";
  }
  return file.text === null ? "blob not text" : null;
}

/**
 * Every document folder in the snapshot: one per `graphs/<slug>` and
 * `nodes/<slug>`. A missing folder is an empty kind, as it is over REST.
 */
export function snapshotSources(snapshot: Snapshot, owner: string, repo: string): SnapshotSource[] {
  const sources: SnapshotSource[] = [];
  if (snapshot.tree === null) {
    return sources;
  }
  const partial = snapshot.errors.length > 0;
  for (const kind of ["graph", "node"] as const) {
    const dir = snapshot.tree.dirs.get(`${kind}s`);
    if (dir === undefined) {
      continue;
    }
    for (const [slug, folder] of dir.dirs) {
      const document = folder.files.get(documentFile(kind));
      const readme = folder.files.get("README.md");
      sources.push({
        source: {
          owner,
          repo,
          directory: documentDirectory(kind, slug),
          kind,
          slug,
          stars: snapshot.stars,
          updated: snapshot.updated,
          ref: snapshot.branch,
        },
        document: document !== undefined && document.present ? document.text : null,
        reason: reasonFor(document, partial),
        readme: readme !== undefined && readme.present ? readme.text : null,
      });
    }
  }
  return sources;
}

/** Load one snapshot folder through the shared document rules. */
export function documentOfSnapshot(item: SnapshotSource, log: Log): Promise<DocumentLoad> {
  if (item.document === null) {
    return Promise.resolve({ kind: "absent", reason: item.reason ?? "missing file" });
  }
  return documentFromTexts(item.source, item.document, () => item.readme, log);
}

/** The removal list the snapshot carried, or null when it could not be read. */
export function blockedOfSnapshot(snapshot: Snapshot): BlockedEntry[] | null {
  const file = snapshot.tree?.files.get(BLOCKED_FILE);
  if (file === undefined || !file.present || file.text === null) {
    return null;
  }
  return parseBlockedList(file.text);
}

/** The slug a `patterns/<slug>.md` file name carries, or null for any other name. */
function pageSlug(name: string): string | null {
  if (!name.endsWith(".md") || name === "README.md") {
    return null;
  }
  const slug = name.slice(0, -".md".length);
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * Read every pattern page out of the snapshot's `patterns/` folder. The
 * folder rides in the same answer as the documents, so the whole pattern
 * set — pages and figures — costs no extra subrequest. A missing folder
 * reads as complete and empty, exactly as a 404 on the REST listing does.
 */
export async function patternsOfSnapshot(
  dir: SnapshotDir | undefined,
  log: Log,
): Promise<PatternsRead> {
  const entries: PatternEntry[] = [];
  const documents = new Map<string, StoredPattern>();
  const invalid: IndexInvalid[] = [];
  if (dir === undefined) {
    return { entries, documents, invalid, complete: true };
  }
  for (const file of dir.files.values()) {
    const slug = pageSlug(file.name);
    if (slug === null) {
      continue;
    }
    if (!file.present) {
      invalid.push({ repo: OFFICIAL_REPOSITORY, slug, reason: "missing file" });
      continue;
    }
    if (file.text === null) {
      invalid.push({ repo: OFFICIAL_REPOSITORY, slug, reason: "blob not text" });
      continue;
    }
    const loaded = await patternFromTexts(slug, file.text, async (name) => {
      const figure = dir.files.get(name);
      if (figure === undefined || !figure.present) {
        return { kind: "absent" };
      }
      if (figure.text === null) {
        return { kind: "error", reason: "blob not text" };
      }
      return { kind: "text", text: figure.text };
    }, log);
    if (loaded.kind === "invalid") {
      invalid.push({ repo: OFFICIAL_REPOSITORY, slug, reason: loaded.reason });
      continue;
    }
    entries.push(loaded.entry);
    documents.set(slug, loaded.stored);
  }
  return { entries, documents, invalid, complete: true };
}

/** Everything one official answer gives the index. */
export interface OfficialCatalogue {
  /** The removal list, or null when `blocked.json` was not readable. */
  blocked: BlockedEntry[] | null;
  documents: SnapshotSource[];
  patterns: PatternsRead;
}

/** Decode the official snapshot into the removal list, documents and patterns. */
export async function officialCatalogueOf(
  snapshot: Snapshot,
  log: Log,
): Promise<OfficialCatalogue> {
  const blocked = blockedOfSnapshot(snapshot);
  if (blocked === null) {
    log("snapshot: blocked.json unreadable; keeping the previous blocks");
  }
  const patterns = snapshot.tree?.dirs.get("patterns");
  return {
    blocked,
    documents: snapshotSources(snapshot, OFFICIAL_OWNER, OFFICIAL_REPO),
    patterns: await patternsOfSnapshot(patterns, log),
  };
}
