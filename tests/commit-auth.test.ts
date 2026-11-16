// A key is asked for twice: at the door, before the request's body has come, and again where what it asks for is
// written. Failure cases: a key taken back, or replaced by a new one under the same name, between those two moments
// still gets its request through (a source's event or message, a worker's message or question as a task elsewhere, its
// heartbeat or claim, a channel's poll, report or answer, the owner's answer, resolve, stop, pause, resume, run, replay
// or removal of a key), because the door's look was taken for the last word; the refusal changes something all the same,
// or a good key is refused afterwards; a card's link goes on answering after the channels stopped taking links, or after
// its week ran out, while its form was still coming, or a link is taken on the door's word where the answer is written
// instead of being known again by what it's made from; a run's token replaced while its result was coming is still taken;
// a key replaced or taken back while its holder waits in a long poll, or reads the log, leaves the wait open; a key that
// came with a request ends up in the log, the view, the stream or the words of a refusal.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-commit-auth-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const rulesFile = join(dir, "rules.json");
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
fixture.elsewhere.push({ ...fixture.elsewhere[0], name: "会问的清理", cwd: "/tmp", prompt: "接着清理。" });
const written = JSON.stringify(fixture);
writeFileSync(rulesFile, written);
setup("commit-auth", rulesFile);

const hub = await import("./hub.ts");
const { createHandler } = await import("../kernel/http.ts");
const { makeHandler } = await import("../host/server.ts");
const { all, one } = await import("./storage.ts");
const { NotFound } = await import("../kernel/errors.ts");

type Kind = "owner" | "source" | "worker" | "channel";
/** Every key and link this file ever used, working or not: none of them may be kept anywhere. */
const secrets: string[] = [];
const keys: Record<string, string> = {};
function issue(kind: Kind, name: string) {
  const key = hub.addKey(kind, name);
  secrets.push(key);
  keys[`${kind}:${name}`] = key;
  return key;
}
issue("owner", "owner");
issue("source", "app");
issue("worker", "w1");
issue("channel", "chat");

// The doors with a clock of this file's own, and a moment to change something between a door's look and what it then
// hands over: what another process writing to the same database does to a request that never waits for a body.
let clock: number | undefined;
let ahead = 0;
/** Moves this file's clock on past the minute within which being seen again isn't written down. */
const later = () => (clock = Date.now() + (ahead += 120_000));
const seenAt = (who: string) => hub.getView().get("seen", who)?.seen_at;
let between: { type: string; change: () => void } | undefined;
const handle = createHandler({
  commit: "test",
  now: () => clock ?? Date.now(),
  view: hub.getView,
  environment: hub.environment,
  dispatch(type: string, args: any[], now: number, holder?: unknown) {
    if (between?.type === type) {
      const { change } = between;
      between = undefined;
      change();
    }
    return (hub.execute as (...all: unknown[]) => unknown)(type, args, now, holder);
  },
  state: hub.stateOf,
  skipped: hub.skipped,
  why: hub.why,
  card: hub.cardByToken,
  wait: async () => {},
  stream: () => new ReadableStream(),
  adapt: async () => [],
});
const headersFor = (key: string) => (key ? { authorization: `Bearer ${key}` } : undefined);

/** A POST the door has looked at and whose body hasn't come yet: `send` delivers it. */
function held(path: string, key: string) {
  let send!: (text: string) => void;
  const body = new ReadableStream({
    start(controller) {
      send = (text) => {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      };
    },
  });
  const init = { method: "POST", headers: headersFor(key), body, duplex: "half" };
  const answered = handle(new Request(`http://local${path}`, init as RequestInit));
  return { send, answered };
}

let n = 0;
const unique = (word: string) => `${word}-${++n}`;
const stored = (id: number) => hub.getView().get("cards", id)!;
const card = (word: string, at = Date.now()) =>
  hub.createCard({ key: unique(word), kind: "ask", title: "选哪个", text: "内容", options: ["甲", "乙"] }, at).card;
/** Hands the channel this card, reporting whatever stands before it as sent. */
function lease(channel: string, id: number) {
  for (let given; (given = hub.nextCard(channel)); hub.delivered(channel, given.id, given.version, `sent-${given.id}`))
    if (given.id === id) return given;
  throw new Error(`card ${id} never came to ${channel}`);
}
const delivery = (id: number, channel = "chat") => hub.getView().get("deliveries", `${id}:${channel}`);
const count = (sql: string, params: (string | number)[] = []) => all(sql, params).length;
const rulePath = (name: string, action: string) => `/v1/rules/${encodeURIComponent(name)}/${action}`;
/** An event the rule 意见 takes, and the run it queued. */
function queued() {
  const { event } = hub.ingest("app", { id: unique("work"), type: "feedback.new", subject: `#${n}` });
  return one<{ run_id: number }>("SELECT run_id FROM run_events WHERE event_id = ?", [event])!.run_id;
}
const runState = (id: number) => hub.getView().get("runs", id)!.state;

/** One request at one door: where it goes, what shows nothing came of it, and what shows it went through. */
type Scene = {
  path: string;
  body?: unknown;
  method?: string;
  untouched(): void;
  went(json: any): void;
};
type Door = {
  name: string;
  key: [Kind, string];
  /** For a door that reads no body: the input before which the key changes. */
  at?: string;
  arrange(): Scene;
};

const doors: Door[] = [
  {
    name: "a source's event",
    key: ["source", "app"],
    arrange() {
      const id = unique("event");
      return {
        path: "/v1/events",
        body: { id, type: "feedback.new", subject: `#${n}` },
        untouched: () => assert.equal(count("SELECT id FROM events WHERE key = ?", [id]), 0),
        went: (json) => assert.equal(json.duplicate, false),
      };
    },
  },
  {
    name: "a source's message",
    key: ["source", "app"],
    arrange() {
      const key = unique("told");
      return {
        path: "/v1/tell",
        body: { key, text: "有话说" },
        untouched: () => assert.equal(count("SELECT id FROM cards WHERE key = ?", [`source:app:${key}`]), 0),
        went: (json) => assert.equal(json.duplicate, false),
      };
    },
  },
  {
    name: "a worker's message as a task elsewhere",
    key: ["worker", "w1"],
    arrange() {
      const key = unique("task-told");
      return {
        path: "/v1/tell",
        body: { task: "每周清理", key, text: "清完了" },
        untouched: () => assert.equal(count("SELECT id FROM cards WHERE key = ?", [`elsewhere:每周清理:${key}`]), 0),
        went: (json) => assert.equal(json.duplicate, false),
      };
    },
  },
  {
    name: "a worker's question as a task elsewhere",
    key: ["worker", "w1"],
    arrange() {
      const title = unique("要不要删");
      return {
        path: "/v1/tell",
        body: { task: "会问的清理", ask: { title, text: "内容", options: ["删", "留"] } },
        untouched: () => assert.equal(count("SELECT id FROM cards WHERE title = ?", [title]), 0),
        went: (json) => assert.equal(json.duplicate, false),
      };
    },
  },
  {
    name: "a worker's heartbeat",
    key: ["worker", "w1"],
    at: "heartbeat",
    arrange() {
      const run = queued();
      const seen = seenAt("worker:w1");
      later();
      return {
        path: `/v1/work?claim=${unique("claim")}&wait=0`,
        method: "GET",
        untouched: () => assert.deepEqual([runState(run), seenAt("worker:w1")], ["queued", seen]),
        went(json) {
          assert.ok(json.job, "with a working key there's work to take");
          hub.finish(json.job.run, json.job.token, { outcome: "done" });
        },
      };
    },
  },
  {
    name: "a worker's claim",
    key: ["worker", "w1"],
    at: "claimNext",
    arrange() {
      const run = queued();
      const claimed = () => count("SELECT id FROM runs WHERE state = 'claimed'");
      const before = claimed();
      return {
        path: `/v1/work?claim=${unique("claim")}&wait=0`,
        method: "GET",
        untouched: () => assert.deepEqual([runState(run), claimed()], ["queued", before]),
        went(json) {
          assert.ok(json.job, "with a working key there's work to take");
          hub.finish(json.job.run, json.job.token, { outcome: "done" });
        },
      };
    },
  },
  ...["channelSeen", "nextCard"].map((at): Door => ({
    name: at === "nextCard" ? "a channel's poll for a card" : "a channel's poll being noted",
    key: ["channel", "chat"],
    at,
    arrange() {
      const id = card("poll");
      const leased = () => count("SELECT card_id FROM deliveries");
      // Being noted comes first: by the time a card is asked for, the poll is on record with the key that still worked.
      const seen = () => (at === "channelSeen" ? seenAt("channel:chat") : null);
      const before = [leased(), seen()];
      later();
      return {
        path: "/v1/cards/next?wait=0",
        method: "GET",
        untouched: () => assert.deepEqual([delivery(id), leased(), seen()], [undefined, ...before]),
        went: (json) => assert.ok(json.card, "with a working key there's a card to take"),
      };
    },
  })),
  {
    name: "a channel's report that a card was sent",
    key: ["channel", "chat"],
    arrange() {
      const id = card("delivered");
      const { version } = lease("chat", id);
      return {
        path: `/v1/cards/${id}/delivered`,
        body: { version, ref: `message-${id}` },
        untouched: () => assert.equal(delivery(id)!.ref, null),
        went: () => assert.equal(delivery(id)!.ref, `message-${id}`),
      };
    },
  },
  {
    name: "a channel's report that a card didn't go out",
    key: ["channel", "chat"],
    arrange() {
      const id = card("failed");
      const { version } = lease("chat", id);
      return {
        path: `/v1/cards/${id}/failed`,
        body: { version, error: "发不出去" },
        untouched: () => assert.equal(delivery(id)!.error, null),
        went: () => assert.equal(delivery(id)!.error, "发不出去"),
      };
    },
  },
  {
    name: "an answer a channel passes on",
    key: ["channel", "chat"],
    arrange() {
      const id = card("channel-answer");
      const { version } = lease("chat", id);
      hub.delivered("chat", id, version, `message-${id}`);
      return {
        path: `/v1/cards/${id}/answer`,
        body: { choice: 0, by: "me", ref: `message-${id}` },
        untouched: () => assert.equal(stored(id).state, "open"),
        went: (json) => assert.deepEqual([json.changed, stored(id).state], [true, "decided"]),
      };
    },
  },
  {
    name: "the owner's answer",
    key: ["owner", "owner"],
    arrange() {
      const id = card("answer");
      return {
        path: `/v1/cards/${id}/answer`,
        body: { choice: 1 },
        untouched: () => assert.deepEqual([stored(id).state, stored(id).choice], ["open", null]),
        went: (json) => assert.deepEqual([json.changed, stored(id).state], [true, "decided"]),
      };
    },
  },
  {
    name: "the owner's resolve",
    key: ["owner", "owner"],
    arrange() {
      const id = card("resolve");
      return {
        path: `/v1/cards/${id}/resolve`,
        body: { reason: "不用决定了" },
        untouched: () => assert.equal(stored(id).state, "open"),
        went: (json) => assert.deepEqual([json.changed, stored(id).state], [true, "closed"]),
      };
    },
  },
  {
    name: "the owner's stop",
    key: ["owner", "owner"],
    at: "cancel",
    arrange() {
      const run = queued();
      return {
        path: `/v1/runs/${run}/cancel`,
        untouched: () => assert.equal(runState(run), "queued"),
        went: () => assert.equal(runState(run), "cancelled"),
      };
    },
  },
  {
    name: "the owner's removal of a key",
    key: ["owner", "owner"],
    at: "removeKey",
    arrange() {
      const name = unique("victim");
      secrets.push(hub.addKey("source", name));
      const there = () => count("SELECT name FROM keys WHERE kind = 'source' AND name = ?", [name]);
      return {
        path: `/v1/keys/source/${name}`,
        method: "DELETE",
        untouched: () => assert.equal(there(), 1),
        went: (json) => assert.deepEqual([json.changed, there()], [true, 0]),
      };
    },
  },
  {
    name: "the owner's pause",
    key: ["owner", "owner"],
    arrange: () => ({
      path: rulePath("意见", "pause"),
      body: { reason: "下游在修" },
      untouched: () => assert.equal(hub.getView().get("pauses", "意见"), undefined),
      went(json) {
        assert.deepEqual([json.changed, json.paused.by], [true, "owner"]);
        hub.execute("resumeRule", ["意见"]);
      },
    }),
  },
  {
    name: "the owner's resume",
    key: ["owner", "owner"],
    arrange() {
      hub.execute("pauseRule", ["意见", "owner", {}]);
      return {
        path: rulePath("意见", "resume"),
        body: {},
        untouched: () => assert.ok(hub.getView().get("pauses", "意见"), "still paused"),
        went: (json) => assert.deepEqual([json.changed, hub.getView().get("pauses", "意见")], [true, undefined]),
      };
    },
  },
  {
    name: "the owner's run of a rule now",
    key: ["owner", "owner"],
    arrange() {
      const manual = () => count("SELECT id FROM events WHERE type = 'run.manual'");
      const before = manual();
      return {
        path: rulePath("巡检", "run"),
        body: { reason: "看一眼" },
        untouched: () => assert.equal(manual(), before),
        went: () => assert.equal(manual(), before + 1),
      };
    },
  },
  {
    name: "the owner's replay of what a pause skipped",
    key: ["owner", "owner"],
    arrange() {
      const since = new Date(Date.now() - 60_000).toISOString();
      hub.execute("pauseRule", ["意见", "owner", {}]);
      const { event, paused } = hub.ingest("app", { id: unique("skipped"), type: "feedback.new", subject: `#${n}` });
      assert.deepEqual(paused, ["意见"]);
      hub.execute("resumeRule", ["意见"]);
      const taken = () => count("SELECT run_id FROM run_events WHERE event_id = ?", [event]);
      return {
        path: rulePath("意见", "replay"),
        body: { since },
        untouched: () => assert.equal(taken(), 0),
        went: (json) => assert.deepEqual([json.events, taken()], [[event], 1]),
      };
    },
  },
];

/** Sends it with this key; `change` happens after the door has looked and before anything is written. */
async function submit(door: Door, scene: Scene, key: string, change?: () => void) {
  if (door.at || scene.method === "GET" || scene.method === "DELETE") {
    assert.ok(!change || door.at, "a request without a body needs the input to change before");
    if (change) between = { type: door.at!, change };
    const response = await handle(
      new Request(`http://local${scene.path}`, { method: scene.method ?? "POST", headers: headersFor(key) }),
    );
    assert.equal(between, undefined, `${door.at} was never handed over`);
    return response;
  }
  const request = held(scene.path, key);
  change?.();
  request.send(JSON.stringify(scene.body));
  return request.answered;
}

const changes: [string, (kind: Kind, name: string) => void][] = [
  ["taken back", (kind, name) => assert.equal(hub.removeKey(kind, name), true)],
  ["replaced by a new one", (kind, name) => void issue(kind, name)],
];
for (const door of doors) {
  for (const [how, change] of changes) {
    const when = door.at ? "between the door's look and the write" : "while the request's body was coming";
    test(`${door.name}, its key ${how} ${when}: refused, and nothing changes`, async (t) => {
      const [kind, name] = door.key;
      // A key of this test's own, so one that an earlier test left dead isn't taken for a refusal here.
      const stale = issue(kind, name);
      const scene = door.arrange();
      t.after(() => (clock = undefined));
      let seq = -1;
      const refused = await submit(door, scene, stale, () => {
        change(kind, name);
        seq = hub.getView().seq;
      });
      const words = await refused.text();
      assert.equal(refused.status, 401, words);
      assert.ok(!words.includes(stale), "the refusal doesn't repeat the key");
      assert.equal(hub.getView().seq, seq, "nothing was written");
      scene.untouched();
      // Not refused for anything else: the key that works now gets the same request through.
      if (keys[`${kind}:${name}`] === stale) issue(kind, name);
      const again = await submit(door, scene, keys[`${kind}:${name}`]);
      assert.equal(again.status, 200);
      scene.went(await again.json());
    });
  }
}

const linkOf = (id: number) => {
  const path = new URL(hub.view(stored(id), null, true).link!).pathname;
  secrets.push(path.slice(3));
  return path;
};

test("a card's link, the channels no longer taking links while its form was coming: nothing is answered", async () => {
  const id = card("link-off");
  const path = linkOf(id);
  const request = held(path, "");
  const without = structuredClone(fixture);
  delete without.channels.plain.links;
  writeFileSync(rulesFile, JSON.stringify(without));
  assert.deepEqual(hub.reloadRules(), {});
  const seq = hub.getView().seq;
  try {
    request.send("choice=0");
    assert.equal((await request.answered).status, 404);
    assert.equal(hub.getView().seq, seq, "nothing was written");
    assert.deepEqual([stored(id).state, stored(id).choice], ["open", null]);
  } finally {
    writeFileSync(rulesFile, written);
    assert.deepEqual(hub.reloadRules(), {});
  }
  const again = held(path, "");
  again.send("choice=0");
  assert.equal((await again.answered).status, 303);
  assert.equal(stored(id).state, "decided");
});

test("a card's link whose week ran out while its form was coming: nothing is answered", async () => {
  const week = 7 * 86400_000;
  clock = Date.now();
  try {
    // A minute of its week is left when the form starts coming, and none when it's all there.
    const id = card("link-late", clock - week + 60_000);
    const request = held(linkOf(id), "");
    clock += 120_000;
    const seq = hub.getView().seq;
    request.send("choice=0");
    assert.equal((await request.answered).status, 401);
    assert.equal(hub.getView().seq, seq, "nothing was written");
    assert.deepEqual([stored(id).state, stored(id).choice], ["open", null]);
  } finally {
    clock = undefined;
  }
});

test("where the answer is written a link is known again by what it's made from: one made up opens nothing", () => {
  const id = card("link-made-up");
  const answerBy = (key: string) =>
    hub.execute("answer", [id, { choice: 0, by: "链接" }], Date.now(), { kind: "link", name: String(id), key });
  assert.throws(() => answerBy("made-up"), NotFound);
  assert.equal(stored(id).state, "open");
  assert.equal(answerBy(linkOf(id).slice(3)).changed, true);
});

test("a run handed out again while its result's body was coming: the token that came with it is refused", async () => {
  queued();
  const claim = unique("claim");
  const job = hub.claimNext("w1", claim)!;
  const request = held(`/v1/runs/${job.run}/result`, job.token);
  // The answer to the claim got lost and it was made again: the run has a new token, and the old one is nobody's.
  const again = hub.claimNext("w1", claim)!;
  assert.deepEqual([again.run, again.token === job.token], [job.run, false]);
  request.send(JSON.stringify({ outcome: "done" }));
  assert.equal((await request.answered).status, 401);
  assert.equal(runState(job.run), "claimed");
  hub.finish(again.run, again.token, { outcome: "done" });
});

test("a key taken back or replaced while its holder waits ends the wait: for work, for a card, on the log", async () => {
  const runtime = makeHandler();
  after(runtime.close);
  const waiting = (path: string, key: string) =>
    runtime.handle(new Request(`http://local${path}`, { headers: headersFor(key), signal: AbortSignal.timeout(5000) }));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The owner's first: the log would otherwise go on to say the other two were changed.
  const holders: [Kind, string][] = [
    ["owner", "owner"],
    ["worker", "w1"],
    ["channel", "chat"],
  ];
  // Nothing is waiting to go out: a poll for a card has to wait.
  for (let given; (given = hub.nextCard("chat"));) hub.delivered("chat", given.id, given.version, `sent-${given.id}`);
  for (const [how, change] of changes) {
    for (const [kind, name] of holders) issue(kind, name);
    const polls = [waiting("/v1/work?claim=waits&wait=50&capacity=0", keys["worker:w1"])];
    polls.push(waiting("/v1/cards/next?wait=50", keys["channel:chat"]));
    const log = await waiting(`/v1/stream?after=${hub.getView().seq}`, keys["owner:owner"]);
    const reader = log.body!.getReader();
    await settle();
    for (const [kind, name] of holders) change(kind, name);
    for (const poll of polls) assert.equal((await poll).status, 401, how);
    assert.equal((await reader.read()).done, true, `${how}: nothing more of the log is sent`);
  }
});

// Last: after every door has been through with a key that worked and one that didn't.
test("no key or link that came with a request is kept: not in the log, the view, or what the stream gives", () => {
  assert.ok(secrets.length > doors.length, "keys were taken back and replaced along the way");
  const kept = [
    all<{ fact: string }>("SELECT fact FROM facts").map((row) => row.fact),
    all<{ data: string }>("SELECT data FROM projections").map((row) => row.data),
    JSON.stringify(hub.logAfter(0)),
  ]
    .flat()
    .join("\n");
  assert.ok(kept.includes("下游在修"), "what the requests said is there to be searched");
  for (const secret of secrets) assert.ok(!kept.includes(secret), "a key or link was written down");
});
