// The GitHub REST calls the Action makes, over plain fetch (no Octokit). `fetch` is injectable.
import { isGeneratedPath } from "../core/diff.ts";
import { DEFAULT_TIMEOUT_MS, type FetchFn } from "./providers/http.ts";

export class GitHubError extends Error {
  override name = "GitHubError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface PullFile {
  filename: string;
  status: string;
  /** Absent for binary files and for diffs too large for GitHub to return. */
  patch?: string;
  previous_filename?: string;
  changes: number;
}

export interface DirEntry {
  name: string;
  type: string;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

export interface Comment {
  id: number;
  body?: string;
  user?: { type?: string } | null;
}

export interface ReviewComment extends Comment {
  path?: string;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface GitHubOptions {
  token: string;
  /** "owner/name" */
  repo: string;
  apiUrl?: string;
  fetch?: FetchFn;
}

const PAGE = 100;
/** Annotations per request (GitHub's limit). */
export const ANNOTATIONS_PER_REQUEST = 50;

export class GitHubClient {
  private readonly token: string;
  private readonly base: string;
  private readonly f: FetchFn;
  constructor(opts: GitHubOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new GitHubError(`bad repository name "${opts.repo}"`, 0);
    this.token = opts.token;
    this.base = `${(opts.apiUrl || "https://api.github.com").replace(/\/+$/, "")}/repos/${opts.repo}`;
    this.f = opts.fetch ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "guardrail-pr-reviewer",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      throw new GitHubError(`GitHub ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) throw await failure(method, path, res);
    return (await res.json()) as T;
  }

  /** Every page of a list endpoint. */
  private async paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.json<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`);
      out.push(...items);
      if (items.length < PAGE) return out;
    }
  }

  listPullFiles(number: number): Promise<PullFile[]> {
    return this.paged<PullFile>(`/pulls/${number}/files`);
  }

  /** Entries of a folder at a commit, or null when it doesn't exist (or is a file). */
  async listDirectory(path: string, ref: string): Promise<DirEntry[] | null> {
    const p = `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
    const res = await this.request("GET", p);
    if (res.status === 404) return null;
    if (!res.ok) throw await failure("GET", p, res);
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as DirEntry[]) : null;
  }

  async getFileText(path: string, ref: string): Promise<string> {
    const p = `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
    const res = await this.request("GET", p, undefined, "application/vnd.github.raw+json");
    if (!res.ok) throw await failure("GET", p, res);
    return res.text();
  }

  async createCheckRun(input: { name: string; headSha: string; conclusion: string; title: string; summary: string; annotations: Annotation[] }): Promise<number> {
    const [first = [], ...rest] = chunk(input.annotations, ANNOTATIONS_PER_REQUEST);
    const created = await this.json<{ id: number }>("POST", "/check-runs", {
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      output: { title: input.title, summary: input.summary, annotations: first },
    });
    // GitHub takes 50 annotations per request; the rest are appended with updates.
    for (const batch of rest) {
      await this.json("PATCH", `/check-runs/${created.id}`, { output: { title: input.title, summary: input.summary, annotations: batch } });
    }
    return created.id;
  }

  listReviewComments(number: number): Promise<ReviewComment[]> {
    return this.paged<ReviewComment>(`/pulls/${number}/comments`);
  }
  /** One pull request review holding all the comments, on the commit that was reviewed. */
  async createReview(number: number, commitId: string, comments: InlineComment[]): Promise<void> {
    await this.json("POST", `/pulls/${number}/reviews`, { commit_id: commitId, event: "COMMENT", comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })) });
  }
  async updateReviewComment(id: number, body: string): Promise<void> {
    await this.json("PATCH", `/pulls/comments/${id}`, { body });
  }

  listIssueComments(number: number): Promise<Comment[]> {
    return this.paged<Comment>(`/issues/${number}/comments`);
  }
  async createComment(number: number, body: string): Promise<void> {
    await this.json("POST", `/issues/${number}/comments`, { body });
  }
  async updateComment(id: number, body: string): Promise<void> {
    await this.json("PATCH", `/issues/comments/${id}`, { body });
  }
}

async function failure(method: string, path: string, res: Response): Promise<GitHubError> {
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    // no JSON body
  }
  const hint = res.status === 403 || res.status === 401 ? " (does the workflow's `permissions:` allow this?)" : "";
  return new GitHubError(`GitHub ${method} ${path.split("?")[0]}: HTTP ${res.status}${detail ? `: ${detail}` : ""}${hint}`, res.status);
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface AssembledDiff {
  /** One unified diff for core/diff.ts. Empty when there's nothing to review. */
  diff: string;
  /** Files GitHub gave no patch for although they changed: too large to return. */
  gaps: { file: string; reason: string }[];
}

/**
 * Join the per-file patches of `pulls/{n}/files` into one unified diff. Deleted files are left out.
 * A file without a patch is either binary (GitHub reports no changed lines for it) or too large for
 * GitHub to include; the first becomes a binary file parseInput lists as not reviewed (not a gap), the
 * second a gap returned here. Generated files (lock files, `dist/`) are the exception: with no patch they are
 * skipped without a gap, as they would be with one.
 */
export function assembleDiff(files: PullFile[]): AssembledDiff {
  const parts: string[] = [];
  const gaps: AssembledDiff["gaps"] = [];
  for (const f of files) {
    if (f.status === "removed") continue;
    const from = f.previous_filename ?? f.filename;
    const header = [`diff --git a/${from} b/${f.filename}`, `--- a/${from}`, `+++ b/${f.filename}`];
    if (f.patch) {
      parts.push([...header, f.patch.endsWith("\n") ? f.patch.slice(0, -1) : f.patch].join("\n"));
    } else if (f.status === "renamed" || f.status === "copied" || f.status === "unchanged") {
      continue; // moved without edits: nothing new to review
    } else if (isGeneratedPath(f.filename)) {
      continue; // a lock file or bundle too big for GitHub to diff: generated, not written, and never sent to the model
    } else if (f.changes > 0) {
      gaps.push({ file: f.filename, reason: "diff too large for GitHub to return" });
    } else {
      parts.push(`diff --git a/${from} b/${f.filename}\nBinary files a/${from} and b/${f.filename} differ`);
    }
  }
  return { diff: parts.length ? `${parts.join("\n")}\n` : "", gaps };
}
