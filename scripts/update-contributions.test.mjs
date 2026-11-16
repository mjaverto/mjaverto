import test from "node:test";
import assert from "node:assert/strict";
import {
  shortDesc,
  formatStars,
  groupRepos,
  renderLine,
  applyBlock,
  fetchContributions,
  needBlurbs,
  fetchReadme,
  askBlurbs,
} from "./update-contributions.mjs";

test("shortDesc cuts at the earliest strong separator or last comma", () => {
  const cases = [
    [
      "Enhanced ChatGPT Clone: Features Agents, MCP, DeepSeek, Anthropic, AWS, OpenAI, Responses API, Azure, Groq",
      "Enhanced ChatGPT Clone",
    ],
    [
      "AI agent toolkit: coding agent CLI, unified LLM API, TUI & web UI libraries, Slack bot, vLLM pods.",
      "AI agent toolkit",
    ],
    [
      "openpilot is an operating system for robotics. Currently, it upgrades the driver assistance system on 300+ supported cars.",
      "openpilot is an operating system for robotics",
    ],
    [
      "Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster by executing routine tasks, explaining complex code, and handling git workflows - all through natural language commands.",
      "Claude Code is an agentic coding tool that lives in your terminal",
    ],
    [":love_hotel: Cascading grid layout plugin.", "Cascading grid layout plugin"],
    ["Mom, liberated. Multi-platform AI agent runtime.", "Mom, liberated. Multi-platform AI agent runtime"],
  ];
  for (const [input, want] of cases) assert.equal(shortDesc(input), want);
});

test("shortDesc handles empty input and shortcode-only input", () => {
  assert.equal(shortDesc(null), "");
  assert.equal(shortDesc(""), "");
  assert.equal(shortDesc(":fire:"), "");
});

test("shortDesc truncates with an ellipsis when no separator fits, within the bound", () => {
  const long = "word ".repeat(60).trim();
  const out = shortDesc(long);
  assert.ok(out.endsWith("\u2026"));
  assert.ok(out.length <= 90);
  assert.equal(shortDesc("x".repeat(200)).length, 90);
});

test("shortDesc neutralizes markdown, HTML and newlines from untrusted text", () => {
  const out = shortDesc("x\n\n#### Pwned ![i](http://e.com/a.png) <b>");
  assert.ok(!out.includes("\n"));
  assert.ok(!/(^|[^\\])[[\]<>]/.test(out));
});

test("formatStars boundaries", () => {
  const want = [
    [0, "0 stars"],
    [1, "1 star"],
    [999, "999 stars"],
    [1000, "1k stars"],
    [2740, "2.7k stars"],
    [38040, "38k stars"],
    [129700, "129.7k stars"],
  ];
  for (const [n, s] of want) assert.equal(formatStars(n), s);
});

const node = (type, name, createdAt, extra = {}) => ({
  __typename: type,
  createdAt,
  repository: { nameWithOwner: name, description: "d", stargazerCount: 1, isPrivate: false, ...extra },
});

test("groupRepos orders newest first, collapses repos, breaks ties by name, and filters", () => {
  const nodes = [
    node("Issue", "b/zeta", "2025-01-01T00:00:00Z"),
    node("PullRequest", "b/zeta", "2025-03-01T00:00:00Z"),
    node("Issue", "a/alpha", "2025-03-01T00:00:00Z"),
    node("PullRequest", "c/old", "2020-01-01T00:00:00Z"),
    node("Issue", "c/old", "2019-01-01T00:00:00Z"),
    node("Issue", "MJaverto/mine", "2026-01-01T00:00:00Z"),
    node("Issue", "p/secret", "2026-01-01T00:00:00Z", { isPrivate: true }),
    node("Issue", "bad name/x", "2026-01-01T00:00:00Z"),
    {},
  ];
  const warn = console.warn;
  console.warn = () => {};
  let repos;
  try {
    repos = groupRepos(nodes, "mjaverto");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(
    repos.map((r) => r.nameWithOwner),
    ["a/alpha", "b/zeta", "c/old"],
  );
});

test("renderLine omits the description part when there is none", () => {
  const base = { nameWithOwner: "o/r", stargazerCount: 1 };
  assert.equal(renderLine({ ...base, description: null }), "- [o/r](https://github.com/o/r) - 1 star");
  assert.equal(
    renderLine({ ...base, stargazerCount: 2740, description: "Hello. World" }),
    "- [o/r](https://github.com/o/r) - 2.7k stars - Hello. World",
  );
});

const README = "intro\n<!-- contributing:start -->\n- old\n<!-- contributing:end -->\n\nmore\n\n*Last updated: 2026-06-02*\n";

test("applyBlock rejects missing, duplicated and reversed markers", () => {
  const S = "<!-- contributing:start -->";
  const E = "<!-- contributing:end -->";
  const go = (r) => () => applyBlock(r, ["- a"], "2026-01-01");
  assert.throws(go("nothing"), /Start marker/);
  assert.throws(go(`${S}\n`), /End marker/);
  assert.throws(go(`${E}\n`), /Start marker/);
  assert.throws(go(`${S}${S}${E}`), /Duplicate start/);
  assert.throws(go(`${S}${E}${E}`), /Duplicate end/);
  assert.throws(go(`${E}${S}`), /before start/);
});

test("applyBlock changes the footer only when the block changed", () => {
  const once = applyBlock(README, ["- a", "- b"], "2026-11-16");
  assert.equal(
    once,
    "intro\n<!-- contributing:start -->\n- a\n- b\n<!-- contributing:end -->\n\nmore\n\n*Last updated: 2026-11-16*\n",
  );
  assert.equal(applyBlock(once, ["- a", "- b"], "2027-01-01"), once);
  assert.equal(
    applyBlock(once, ["- a"], "2027-01-01"),
    once.replace("- b\n", "").replace("2026-11-16", "2027-01-01"),
  );
});

test("applyBlock leaves a README without a footer alone outside the block", () => {
  const out = applyBlock("<!-- contributing:start -->\n- x\n<!-- contributing:end -->\n", ["- y"], "2026-01-01");
  assert.equal(out, "<!-- contributing:start -->\n- y\n<!-- contributing:end -->\n");
});

const page = (nodes, issueCount, next) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: { search: { issueCount, pageInfo: { hasNextPage: next !== undefined, endCursor: next }, nodes } },
  }),
});

test("fetchContributions aggregates pages and passes the cursor", async () => {
  const cursors = [];
  const fetchImpl = async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    cursors.push(variables.cursor);
    assert.equal(init.headers.Authorization, "Bearer tok");
    return variables.cursor
      ? page([node("Issue", "b/b", "2025-01-01T00:00:00Z")], 2)
      : page([node("Issue", "a/a", "2025-02-01T00:00:00Z")], 2, "C1");
  };
  const nodes = await fetchContributions({ token: "tok", user: "u", fetchImpl });
  assert.equal(nodes.length, 2);
  assert.deepEqual(cursors, [null, "C1"]);
});

test("fetchContributions fails on GraphQL errors, HTTP errors and short results", async () => {
  const args = { token: "t", user: "u" };
  await assert.rejects(
    fetchContributions({
      ...args,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "boom" }] }) }),
    }),
    /boom/,
  );
  await assert.rejects(
    fetchContributions({ ...args, fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) }),
    /502/,
  );
  await assert.rejects(
    fetchContributions({ ...args, fetchImpl: async () => page([node("Issue", "a/a", "2025-01-01T00:00:00Z")], 5) }),
    /Incomplete/,
  );
});

test("fetchContributions accepts results beyond the 1000 search cap", async () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => node("Issue", `o/r${i}`, "2025-01-01T00:00:00Z"));
  const out = await fetchContributions({ token: "t", user: "u", fetchImpl: async () => page(nodes, 5000) });
  assert.equal(out.length, 1000);
});

test("fetchContributions drops null nodes before counting and rejects a missing cursor", async () => {
  const n = node("Issue", "a/a", "2025-01-01T00:00:00Z");
  const out = await fetchContributions({ token: "t", user: "u", fetchImpl: async () => page([n, null], 1) });
  assert.equal(out.length, 1);
  await assert.rejects(
    fetchContributions({ token: "t", user: "u", fetchImpl: async () => page([n], 2, null) }),
    /endCursor/,
  );
});

test("shortDesc strips URLs and emails", () => {
  assert.equal(shortDesc("Cool tool https://evil.example/x?a=1 by me@evil.example"), "Cool tool by");
  assert.equal(shortDesc("See www.evil.example now"), "See now");
});

test("shortDesc never leaves a lone surrogate when cutting", () => {
  const out = shortDesc("x".repeat(88) + "\u{1F1FA}\u{1F1F8}".repeat(3));
  assert.equal(out, "x".repeat(88) + "\u2026");
  assert.equal(out.isWellFormed(), true);
});

test("renderLine prefers an override and still sanitizes it", () => {
  const repo = { nameWithOwner: "o/r", stargazerCount: 0, description: "from github" };
  assert.equal(renderLine(repo, { "o/r": "My *pinned* blurb" }), "- [o/r](https://github.com/o/r) - 0 stars - My \\*pinned\\* blurb");
  assert.match(renderLine(repo, {}), /from github$/);
});

const text = (status, body) => async () => ({ ok: status < 400, status, text: async () => body });

test("fetchReadme truncates to 2000 chars and returns null on errors or empty bodies", async () => {
  assert.equal((await fetchReadme("o/r", { token: "t", fetchImpl: text(200, "x".repeat(5000)) })).length, 2000);
  assert.equal(await fetchReadme("o/r", { token: "t", fetchImpl: text(404, "Not Found") }), null);
  assert.equal(await fetchReadme("o/r", { token: "t", fetchImpl: text(200, "  \n") }), null);
  assert.equal(await fetchReadme("o/r", { token: "t", fetchImpl: async () => { throw new Error("net"); } }), null);
});

test("needBlurbs selects truncated descriptions and readme-backed empty ones, never pinned repos", async () => {
  const long = "word ".repeat(60);
  const repos = [
    { nameWithOwner: "a/long", description: long },
    { nameWithOwner: "b/pinned", description: long },
    { nameWithOwner: "c/empty-with-readme", description: ":fire:" },
    { nameWithOwner: "d/empty-no-readme", description: null },
    { nameWithOwner: "e/short", description: "Short one" },
    { nameWithOwner: "f/pinned-empty", description: null },
  ];
  const fetchImpl = async (url) => text(url.includes("/c/") ? 200 : 404, "# C\nA thing")();
  const warn = console.warn;
  console.warn = () => {};
  let need;
  try {
    need = await needBlurbs(repos, { "b/pinned": "x", "f/pinned-empty": "y" }, { token: "t", fetchImpl });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(need.map((r) => r.nameWithOwner), ["a/long", "c/empty-with-readme"]);
  assert.equal(need[1].readme, "# C\nA thing");
});

test("askBlurbs extracts JSON from prose, drops foreign keys and non-strings, throws on garbage", () => {
  const need = [{ nameWithOwner: "a/x", description: "d" }, { nameWithOwner: "b/y", description: "d" }, { nameWithOwner: "c/z", description: "d" }];
  const reply = 'Sure!\n```json\n{"a/x": "  A\\n tool ", "b/y": 5, "evil/other": "nope", "c/z": "  "}\n```';
  assert.deepEqual(askBlurbs(need, { model: "m", run: () => reply }), { "a/x": "A tool" });
  assert.throws(() => askBlurbs(need, { model: "m", run: () => "no json here" }));
});
