// A member's side of the command line and of MCP, run for real against a hub. Failure cases: `key new person` makes a key
// for someone not registered, or one that doesn't work; `key remove person` leaves it working; `join --person` writes a
// config with a key the hub doesn't take or that is someone else's, replaces a machine's existing keys, points an existing
// config at another hub, or installs a service on a machine with nothing to run; added to a machine that takes work it
// says nothing of what that means; `me` shows nothing a member can act on; `answer` and `say` from a member's machine
// go out under no key or the wrong one; with the owner's and a member's key side by side a card is answered with the key
// that can't answer it; `status` on a member's machine fails without saying what to run instead; `doctor` there calls a
// missing service a fault, or doesn't notice a dead key; `service install` there (which running the installer again to
// update does) sets up a service that starts nothing over and over; MCP on a member's machine offers the owner's tools, runs one it
// doesn't offer, or doesn't say what a member can't do; `check` passes in silence a rules file where a card for someone
// can only ever be seen with a key nobody was told to make, or where a member's message can't be answered to them.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-member-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const base = {
  timezone: "Asia/Shanghai",
  sources: { app: { name: "应用" } },
  agents: { a1: { name: "甲", worker: "w1", use: "claude" } },
  people: { alice: { name: "前端 A" }, bob: { name: "后端 B" }, carol: { name: "测试 C", workers: ["w1"] } },
  rules: [
    {
      name: "指派",
      when: { source: "app", types: ["assign.*"] },
      to: "a1",
      cwd: "~/x",
      prompt: "派活。",
      parallel: 3,
      people: ["*"],
    },
    { name: "成员提问", when: { source: "people", types: ["question"] }, to: "a1", cwd: "~/x", prompt: "答。" },
  ],
};
const rulesFile = join(dir, "rules.json");
writeFileSync(rulesFile, JSON.stringify(base));
const hubHome = setup("member-cli", rulesFile);

const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { all, one } = await import("./storage.ts");
const server = serve(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const ownerKey = hub.addKey("owner", "owner");
writeFileSync(join(hubHome, "config.json"), JSON.stringify({ url, owner: ownerKey }));

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** The command line for real, on the machine whose home this is. */
function cli(home: string, ...args: string[]) {
  return run(home, {}, ...args);
}
function run(home: string, extra: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const env = { ...process.env, AGENT_AUTOLOOP_HOME: home, ...extra };
    const child = execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, ...args],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => done({ code: error ? ((error as any).code ?? 1) : 0, stdout, stderr }),
    );
    // Nothing is typed: a command that reads what to say from its input finds it empty rather than waiting.
    child.stdin!.end();
  });
}
/** A machine of its own: an empty home, or one with this config.json. */
function machine(name: string, config?: object) {
  const home = join(dir, name);
  if (config) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
  }
  return home;
}
const configOf = (home: string) => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
const stored = (id: number) => one<any>('SELECT state, choice, by, "to" FROM cards WHERE id = ?', [id])!;
const me = (key: string) => fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${key}` } });
let n = 0;
/** A round of 指派 that asks: one card for `to`, or for the owner. */
function asked(to?: string) {
  hub.ingest("app", { id: `e${++n}`, type: "assign.new", subject: `#${n}` });
  const job = hub.claimNext("w1", `c${n}`)!;
  const ask = { title: "接这个任务吗", text: "登录页改版", options: ["接", "退回"], recommend: 0, ...(to && { to }) };
  hub.finish(job.run, job.token, { outcome: "done", ask: [ask] });
  return all<any>("SELECT id FROM cards WHERE run_id = ?", [job.run])[0].id as number;
}

const bobKey = hub.addKey("person", "bob");
const bobs = machine("bob", { url, person: { id: "bob", key: bobKey } });

test("key new person makes a working key for someone registered, and key remove ends it", async () => {
  const made = await cli(hubHome, "key", "new", "person", "alice");
  assert.equal(made.code, 0, made.stderr);
  const key = made.stdout.trim();
  assert.equal((await me(key)).status, 200);
  const stranger = await cli(hubHome, "key", "new", "person", "mallory");
  assert.equal(stranger.code, 1);
  assert.match(stranger.stderr, /people/);
  assert.match((await cli(hubHome, "key", "list")).stdout, /^person alice /m);
  const removed = await cli(hubHome, "key", "remove", "person", "alice");
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((await me(key)).status, 401);
});

test("join --person checks the key with the hub before it writes anything, and installs nothing", async () => {
  const fresh = machine("fresh");
  const wrong = await cli(fresh, "join", url, "--person", "bob", "--key", "not-a-key");
  assert.equal(wrong.code, 1);
  const others = await cli(fresh, "join", url, "--person", "alice", "--key", bobKey);
  assert.equal(others.code, 1);
  assert.match(others.stderr, /bob/);
  assert.equal(existsSync(join(fresh, "config.json")), false);
  const joined = await cli(fresh, "join", url, "--person", "bob", "--key", bobKey);
  assert.equal(joined.code, 0, joined.stderr);
  assert.match(joined.stdout, /后端 B/);
  assert.deepEqual(configOf(fresh), { url, person: { id: "bob", key: bobKey } });
});

test("join --person adds to a machine already on this hub and says what that means, and never repoints or replaces", async () => {
  const worker = { url, worker: { name: "w1", key: "worker-key" } };
  const taking = machine("taking", worker);
  const added = await cli(taking, "join", url, "--person", "bob", "--key", bobKey);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(configOf(taking), { ...worker, person: { id: "bob", key: bobKey } });
  assert.match(added.stdout + added.stderr, /接活/);
  const twice = await cli(taking, "join", url, "--person", "bob", "--key", bobKey);
  assert.equal(twice.code, 1);
  const elsewhere = machine("elsewhere", { url: "https://old-hub.example", worker: worker.worker });
  const refused = await cli(elsewhere, "join", url, "--person", "bob", "--key", bobKey);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /已经配置过了/);
  assert.deepEqual(configOf(elsewhere), { url: "https://old-hub.example", worker: worker.worker });
});

test("me shows a member who they are and what waits for them, and how to answer it", async () => {
  const card = asked("bob");
  const shown = await cli(bobs, "me");
  assert.equal(shown.code, 0, shown.stderr);
  for (const words of ["后端 B", `#${card} 接这个任务吗`, "来源：指派", "登录页改版", "1. 接（推荐）"]) {
    assert.ok(shown.stdout.includes(words), `${words}\n${shown.stdout}`);
  }
  assert.ok(shown.stdout.includes(`agent-autoloop answer ${card} <序号>`));
  const raw = JSON.parse((await cli(bobs, "me", "--json")).stdout);
  assert.deepEqual(raw.me, { id: "bob", name: "后端 B" });
  assert.ok(raw.cards.some((open: any) => open.id === card));
});

test("answer and say from a member's machine go out under the member's key", async () => {
  const card = asked("bob");
  const answered = await cli(bobs, "answer", String(card), "2");
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual([stored(card).state, stored(card).by, stored(card).choice], ["decided", "bob", 1]);

  const told = await cli(bobs, "say", "question", "--subject", "T-9", "登录页", "用哪个接口");
  assert.equal(told.code, 0, told.stderr);
  assert.match(told.stdout, /成员提问/);
  const event = one<any>(
    "SELECT id, subject, summary, detail FROM events WHERE source = 'people' AND subject = 'T-9'",
  )!;
  assert.deepEqual([event.summary, event.detail], ["登录页 用哪个接口", "登录页 用哪个接口"]);
  assert.equal(hub.getView().get("events", event.id)!.from, "bob");
  assert.match((await cli(bobs, "say", "nobody.takes", "有人吗")).stdout, /没有规则接/);
  const nothing = await cli(bobs, "say", "question");
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /不能为空/);
});

test("check points out who only a key reaches, and a rule that takes members' messages but can't write back", async () => {
  const checked = await cli(hubHome, "check");
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /规则没问题/);
  assert.match(checked.stdout, /bob（后端 B）.*key new person bob/);
  assert.match(checked.stdout, /carol（测试 C）写了 workers 却没有通道地址/);
  assert.match(checked.stdout, /规则「成员提问」.*people/);
  assert.ok(!checked.stdout.includes("规则「指派」"), "a rule that may name everyone has nothing to be told");
});

test("with the owner's key and a member's side by side, each card is answered with the key that may", async () => {
  const both = machine("both", { url, owner: ownerKey, person: { id: "bob", key: bobKey } });
  const [his, owners] = [asked("bob"), asked()];
  assert.equal((await cli(both, "answer", String(his), "1")).code, 0);
  assert.equal((await cli(both, "answer", String(owners), "1")).code, 0);
  assert.deepEqual([stored(his).by, stored(owners).by], ["bob", "本人"]);
});

test("status and doctor on a member's machine say what a member can do there", async () => {
  const status = await cli(bobs, "status");
  assert.equal(status.code, 1);
  assert.match(status.stderr, /agent-autoloop me/);
  const healthy = await cli(bobs, "doctor");
  assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /● 成员 后端 B（bob）/);
  assert.ok(!healthy.stdout.includes("service install"), "nothing runs on a machine that only has a member's key");
  // Were it to install after all, it would be into this folder and with no service manager to be found.
  const nowhere = join(dir, "no-user-home");
  const sealed = { HOME: nowhere, USERPROFILE: nowhere, PATH: dirname(process.execPath) };
  const service = await run(bobs, sealed, "service", "install");
  assert.equal(service.code, 0, service.stderr);
  assert.match(service.stdout, /不用装系统服务/);
  assert.equal(existsSync(nowhere), false, "nothing was written for a service");
  const dead = machine("dead", { url, person: { id: "bob", key: "revoked" } });
  const broken = await cli(dead, "doctor");
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /○ 成员密钥/);
});

test("MCP on a member's machine offers the member's three tools, which say what they can't do, and no other", async () => {
  const card = asked("bob");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", program, "mcp"], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: bobs },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stop = setTimeout(() => child.kill(), 30_000);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const tool = (id: number, name: string, args: object) => ({
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    tool(3, "me", {}),
    tool(4, "answer", { card, choice: 0 }),
    tool(5, "say", { type: "question", text: "环境起不来", subject: "T-10" }),
    tool(6, "status", {}),
    tool(7, "resolve", { card, reason: "不用了" }),
  ];
  child.stdin.end(messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n");
  await once(child, "close");
  clearTimeout(stop);
  const answers = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((answer) => [answer.id, answer]),
  );
  const tools = answers.get(2).result.tools;
  assert.deepEqual(
    tools.map((one: any) => one.name),
    ["me", "answer", "say"],
  );
  for (const one of tools) assert.match(one.description, /不能/, one.name);
  const text = (id: number) => JSON.parse(answers.get(id).result.content[0].text);
  assert.deepEqual(text(3).me, { id: "bob", name: "后端 B" });
  assert.deepEqual(text(4), { changed: true, state: "decided" });
  assert.equal(stored(card).by, "bob");
  assert.deepEqual(text(5).routed, ["成员提问"]);
  const event = one<any>("SELECT id, detail FROM events WHERE source = 'people' AND subject = 'T-10'")!;
  assert.equal(event.detail, "环境起不来");
  assert.equal(answers.get(6).error.code, -32602);
  assert.equal(answers.get(7).error.code, -32602);
});
