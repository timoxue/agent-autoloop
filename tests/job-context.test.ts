// What a script run as an Agent can read of its round. It sees only the context file, never the prompt's words. Failure
// cases: the file doesn't say which rule this is, whom the rule may name or what it may send, so a script has to be told
// the list a second time on its command line and the two drift apart; an open card doesn't say which matter it belongs
// to or the key its receipt gave it, so under `parallel` a script signs its cards in their text to find them again, or
// the key comes back with the hub's own prefix, the recipient's, or made up for a card that was given none; a decision
// doesn't say which question it answered; the file has no moment for "now", so a script takes an event's arrival for it,
// or the moment moves when the same job is handed out again; the round's matter has to be guessed from its events,
// which a round of answers and look-agains hasn't got; a job with the new fields fails the protocol's schema, or one
// from an older hub without them does.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";
import { checkSchema } from "../protocol/schema.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-context-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const rulesFile = join(dir, "rules.json");
writeFileSync(
  rulesFile,
  JSON.stringify({
    timezone: "Asia/Shanghai",
    sources: { app: { name: "应用" } },
    agents: { a1: { name: "甲", worker: "w1", use: "command", command: ["true"] } },
    channels: { chat: { name: "聊天", answerers: ["me"] }, team: { name: "团队", people: true } },
    people: { ada: { name: "阿达", at: { team: "ou_a" } }, bo: { name: "小波", at: { team: "ou_b" } } },
    rules: [
      {
        name: "交办",
        when: { source: "app", types: ["assign.*"] },
        to: "a1",
        cwd: "~/x",
        group: "work",
        parallel: 3,
        people: ["ada"],
        emits: { source: "app", types: ["assigned.*"] },
      },
      { name: "同组", when: { source: "app", types: ["peer.*"] }, to: "a1", cwd: "~/x", group: "work", parallel: 3 },
    ],
  }),
);
setup("job-context", rulesFile);

const { answer, claimNext, finish, ingest } = await import("./hub.ts");

let n = 0;
function take(subject: string, now: number, type = "assign.request") {
  ingest("app", { id: `e${++n}`, type, subject }, at(now));
  return claimNext("w1", `c${++n}`, at(now))!;
}
const ask = (extra: object = {}) => ({ title: "接吗", text: "登录页改版", options: ["接", "退回"], ...extra });

test("the context says which rule this is, whom it may name and what it may send; a rule with neither says only its name", () => {
  const job = take("T-1", 0);
  assert.deepEqual(job.context.rule, {
    name: "交办",
    people: [{ id: "ada", name: "阿达" }],
    emits: { source: "app", types: ["assigned.*"] },
  });
  finish(job.run, job.token, { outcome: "done" }, at(1));
  const plain = take("T-1", 2, "peer.came");
  assert.deepEqual(plain.context.rule, { name: "同组" });
  finish(plain.run, plain.token, { outcome: "done" }, at(3));
});

test("an open card says its rule, its matter and the key its receipt gave it; one named by its words has no key", () => {
  const first = take("T-2", 10);
  const receipt = { ask: [ask({ key: "offer", to: "ada" }), ask({ key: "to:x:thread:y" }), ask({ title: "没起名" })] };
  finish(first.run, first.token, { outcome: "done", ...receipt }, at(11));
  const elsewhere = take("T-3", 12);
  finish(
    elsewhere.run,
    elsewhere.token,
    { outcome: "done", notice: [{ title: "看一眼", text: "这个", key: "note" }] },
    at(13),
  );
  const next = take("T-2", 14);
  assert.equal(next.context.lane, "T-2");
  assert.deepEqual(
    next.context.open.map(({ title, rule, lane, key, to }) => ({ title, rule, lane, key, to: to?.id })),
    [
      { title: "接吗", rule: "交办", lane: "T-2", key: "offer", to: "ada" },
      { title: "接吗", rule: "交办", lane: "T-2", key: "to:x:thread:y", to: undefined },
      { title: "没起名", rule: "交办", lane: "T-2", key: undefined, to: undefined },
      { title: "看一眼", rule: "交办", lane: "T-3", key: "note", to: undefined },
    ],
  );
  assert.ok(!("key" in next.context.open[2]), "a card given no key has none here");
  finish(next.run, next.token, { outcome: "done" }, at(15));
});

test("a decision says the key of the question it answered", () => {
  const first = take("T-4", 20);
  finish(first.run, first.token, { outcome: "done", ask: [ask({ key: "offer" }), ask({ title: "没起名" })] }, at(21));
  const second = take("T-4", 22);
  const [named, unnamed] = second.context.open.filter((card) => card.lane === "T-4");
  finish(second.run, second.token, { outcome: "done" }, at(22));
  answer(named.card, { choice: 0, by: "本人" }, at(23));
  answer(unnamed.card, { choice: 1, by: "本人" }, at(23));
  const job = claimNext("w1", `c${++n}`, at(23))!;
  finish(job.run, job.token, { outcome: "done" }, at(24));
  const later = take("T-4", 25);
  assert.deepEqual(
    later.context.decided.map(({ card, key }) => ({ card, key })),
    [
      { card: unnamed.card, key: undefined },
      { card: named.card, key: "offer" },
    ],
  );
  assert.ok(!("key" in later.context.decided[0]));
});

test("the context has the moment the round was handed out: the same on a repeated claim, the new one's on a retry", () => {
  ingest("app", { id: `e${++n}`, type: "assign.request", subject: "T-5" }, at(30));
  const job = claimNext("w1", "same-claim", at(31))!;
  assert.equal(job.context.claimedAt, new Date(at(31)).toISOString());
  const again = claimNext("w1", "same-claim", at(33))!;
  assert.equal(again.run, job.run);
  assert.equal(again.context.claimedAt, job.context.claimedAt, "the answer got lost: it's the same execution");
  finish(again.run, again.token, { outcome: "failed", error: "网络断了" }, at(34));
  const retry = claimNext("w1", `c${++n}`, at(40))!;
  assert.equal(retry.run, job.run);
  assert.equal(retry.context.claimedAt, new Date(at(40)).toISOString());
  finish(retry.run, retry.token, { outcome: "done" }, at(41));
});

test("a job with the new fields passes the schema, and so does an older hub's without them", () => {
  // As it goes over the wire.
  const job: ReturnType<typeof take> = JSON.parse(JSON.stringify(take("T-6", 50)));
  assert.deepEqual(checkSchema("job", job), []);
  const { rule: _rule, lane: _lane, claimedAt: _claimedAt, ...older } = job.context;
  assert.deepEqual(checkSchema("job", { ...job, context: older }), []);
  assert.ok(checkSchema("job", { ...job, context: { ...job.context, claimedAt: 5 } }).length);
});
