// Regenerates the "Public / external projects" list in ../README.md from GitHub.
// One line per public repo (not owned by PROFILE_USER) where PROFILE_USER authored a PR or issue,
// newest contribution first. Line: link, stars, short repo description.
//
// Usage:  node scripts/update-contributions.mjs [--dry-run]
// Env:    GITHUB_TOKEN (required), PROFILE_USER (default "mjaverto")
// Markers in README.md: <!-- contributing:start --> ... <!-- contributing:end -->
//         Only the text between them (and the "*Last updated: YYYY-MM-DD*" footer) is rewritten.
// Local:  GITHUB_TOKEN=$(gh auth token) node scripts/update-contributions.mjs --dry-run
// --dry-run prints the generated lines and writes nothing.
// Fails loudly (non-zero exit, README untouched) on API errors or incomplete data
// instead of publishing a partial list.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const START = "<!-- contributing:start -->";
const END = "<!-- contributing:end -->";
const MAX_PAGES = 10;
const SEARCH_CAP = 1000;
const NAME_RE = /^[\w.-]+\/[\w.-]+$/;
const STRONG_SEPARATORS = [": ", " - ", " \u2013 ", " \u2014 ", ". ", "; "];

const QUERY = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { createdAt repository { nameWithOwner description stargazerCount isPrivate } }
      ... on PullRequest { createdAt repository { nameWithOwner description stargazerCount isPrivate } }
    }
  }
}`;

export function shortDesc(raw, max = 90) {
  let s = (raw ?? "")
    .replace(/(^|\s):[a-z0-9_+-]+:(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();

  if (s.length > max) {
    let cut = -1;
    for (const sep of STRONG_SEPARATORS) {
      for (let i = s.indexOf(sep); i !== -1 && i <= max; i = s.indexOf(sep, i + 1)) {
        if (i >= 12) {
          if (cut === -1 || i < cut) cut = i;
          break;
        }
      }
    }
    if (cut === -1) {
      const i = s.slice(0, max + 1).lastIndexOf(", ");
      if (i >= 30 && i <= max) cut = i;
    }
    if (cut !== -1) {
      s = s.slice(0, cut).trim();
    } else {
      const sp = s.lastIndexOf(" ", max - 1);
      s = (sp > 0 ? s.slice(0, sp).trimEnd() : s.slice(0, max - 1)) + "\u2026";
    }
  }
  return s.replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

export function formatStars(n) {
  if (n < 1000) return `${n} ${n === 1 ? "star" : "stars"}`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k stars`;
}

export function groupRepos(nodes, user) {
  const owner = user.toLowerCase();
  const byName = new Map();
  for (const node of nodes) {
    const repo = node?.repository;
    if (!repo || repo.isPrivate) continue;
    const name = repo.nameWithOwner;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      console.warn(`Skipping repo with unexpected name: ${JSON.stringify(name)}`);
      continue;
    }
    if (name.split("/")[0].toLowerCase() === owner) continue;
    const ts = Date.parse(node.createdAt);
    if (Number.isNaN(ts)) continue;
    const prev = byName.get(name);
    if (prev) {
      if (ts > prev.latest) prev.latest = ts;
    } else {
      byName.set(name, {
        nameWithOwner: name,
        description: repo.description ?? null,
        stargazerCount: repo.stargazerCount ?? 0,
        latest: ts,
      });
    }
  }
  return [...byName.values()].sort(
    (a, b) =>
      b.latest - a.latest ||
      (a.nameWithOwner < b.nameWithOwner ? -1 : a.nameWithOwner > b.nameWithOwner ? 1 : 0),
  );
}

export function renderLine(repo) {
  const name = repo.nameWithOwner;
  const desc = shortDesc(repo.description);
  const base = `- [${name}](https://github.com/${name}) - ${formatStars(repo.stargazerCount)}`;
  return desc ? `${base} - ${desc}` : base;
}

export function applyBlock(readme, lines, today) {
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1) throw new Error(`Start marker ${START} not found`);
  if (e === -1) throw new Error(`End marker ${END} not found`);
  if (readme.indexOf(START, s + 1) !== -1) throw new Error("Duplicate start marker");
  if (readme.indexOf(END, e + 1) !== -1) throw new Error("Duplicate end marker");
  if (e < s) throw new Error("End marker appears before start marker");

  const next =
    readme.slice(0, s + START.length) + "\n" + lines.join("\n") + "\n" + readme.slice(e);
  if (next === readme) return readme;
  return next.replace(
    /^\*Last updated: \d{4}-\d{2}-\d{2}\*$/m,
    () => `*Last updated: ${today}*`,
  );
}

export async function fetchContributions({ token, user, fetchImpl = fetch }) {
  const q = `author:${user} -user:${user} is:public sort:created-desc`;
  const nodes = [];
  let issueCount = 0;
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "update-contributions",
      },
      body: JSON.stringify({ query: QUERY, variables: { q, cursor } }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL request failed: HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) {
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    const search = body.data?.search;
    if (!search) throw new Error("GitHub GraphQL response has no data.search");
    issueCount = search.issueCount;
    nodes.push(...search.nodes);
    if (!search.pageInfo.hasNextPage) break;
    cursor = search.pageInfo.endCursor;
  }
  if (issueCount > SEARCH_CAP) {
    console.warn(`issueCount ${issueCount} exceeds ${SEARCH_CAP}; older contributions are not visible`);
  }
  const expected = Math.min(issueCount, SEARCH_CAP);
  if (nodes.length < expected) {
    throw new Error(`Incomplete data: fetched ${nodes.length} of ${expected} results`);
  }
  return nodes;
}

export async function main(argv = process.argv.slice(2)) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN is required");
    process.exit(1);
  }
  const user = process.env.PROFILE_USER || "mjaverto";
  const dryRun = argv.includes("--dry-run");
  try {
    const nodes = await fetchContributions({ token, user });
    const repos = groupRepos(nodes, user);
    if (repos.length === 0) throw new Error("No contributed repos found; refusing to publish an empty list");
    const lines = repos.map(renderLine);
    if (dryRun) {
      console.log(lines.join("\n"));
      return;
    }
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    const updated = applyBlock(readme, lines, today);
    if (updated !== readme) writeFileSync(readmePath, updated);
    console.error(`${repos.length} repos; README ${updated === readme ? "unchanged" : "updated"}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
