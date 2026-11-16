import test from "node:test";
import assert from "node:assert/strict";
import {
  shortDesc,
  formatStars,
  groupRepos,
  renderLine,
  applyBlock,
  fetchContributions,
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
    null,
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
  assert.throws(() => applyBlock("nothing", ["- a"], "2026-01-01"));
  assert.throws(() => applyBlock(`${S}\n`, ["- a"], "2026-01-01"));
  assert.throws(() => applyBlock(`${E}\n`, ["- a"], "2026-01-01"));
  assert.throws(() => applyBlock(`${S}${S}${E}`, ["- a"], "2026-01-01"));
  assert.throws(() => applyBlock(`${S}${E}${E}`, ["- a"], "2026-01-01"));
  assert.throws(() => applyBlock(`${E}${S}`, ["- a"], "2026-01-01"));
});

test("applyBlock replaces only the block, bumps the footer date, and is stable within a day", () => {
  const once = applyBlock(README, ["- a", "- b"], "2026-11-16");
  assert.equal(
    once,
    "intro\n<!-- contributing:start -->\n- a\n- b\n<!-- contributing:end -->\n\nmore\n\n*Last updated: 2026-11-16*\n",
  );
  assert.equal(applyBlock(once, ["- a", "- b"], "2026-11-16"), once);
  assert.equal(applyBlock(once, ["- a", "- b"], "2027-01-01"), once.replace("2026-11-16", "2027-01-01"));
});

test("applyBlock leaves a README without a footer alone outside the block", () => {
  const out = applyBlock("<!-- contributing:start -->\n- x\n<!-- contributing:end -->\n", ["- y"], "2026-01-01");
  assert.equal(out, "<!-- contributing:start -->\n- y\n<!-- contributing:end -->\n");
});

const page = (nodes, issueCount, next) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: { search: { issueCount, pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } },
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
