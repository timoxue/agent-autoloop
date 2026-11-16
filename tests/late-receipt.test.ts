// A round the hub lost track of, handing in after its matter went on without it. Failure cases: a round that went quiet
// asked someone and booked a look-again, a newer round of the same matter asked someone else and booked its own, and the
// old round's receipt, in late, puts the look-again back to what it was, so two people hold an open card and the matter
// follows only the first; an old round that was ending the matter comes in after a newer one began it again, and writes
// the look-again as ended, leaving the new card with nothing following it; a late receipt opens a card, closes one the
// newer round kept, books, moves or cancels a look-again, or sends an event, each by what the matter was before the
// newer round. A late round whose matter no one took meanwhile loses what it asked for, or any round does; a run tried
// again after failing is taken for a late one; the same result handed in twice takes effect twice, or is answered
// differently; a rule with no `parallel`, whose every event is one matter, isn't covered; a round of another rule that
// shares the group and the subject counts as having taken the matter; what was dropped can't be seen in the answer, in
// `why` or by the owner, or the owner is told when nothing was dropped; the round's own ending (state, summary, usage,
// session, the answer it carried out) is lost with the rest; a claim leaves a mark in the log when nothing was passed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";
import { formatWhy } from "../cli/why.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-late-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const rule = (name: string, type: string, more: object = {}) => ({
  name,
  when: { source: "app", types: [`${type}.*`] },
  to: "a1",
  cwd: "~/x",
  prompt: "做事。",
  ...more,
});
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
      rule("交办", "assign", {
        group: "work",
        parallel: 3,
        people: ["*"],
        emits: { source: "app", types: ["assigned.*"] },
      }),
      rule("同组", "peer", { group: "work", parallel: 3 }),
      rule("单线", "plain", { tell: "always" }),
    ],
  }),
);
setup("late-receipt", rulesFile);

const hub = await import("./hub.ts");
const { answer, claimNext, finish, heartbeat, ingest, logAfter, sweep, why } = hub;
const { AuthError } = await import("../kernel/errors.ts");
const { all, one } = await import("./storage.ts");

let n = 0;
/** Each test has a matter and a stretch of time to itself. */
const fresh = () => ({ subject: `T-${++n}`, t: n * 1000 });
const event = (subject: string, type = "assign.request") => ({ id: `e${++n}`, type, subject });
function take(subject: string, now: number, type = "assign.request") {
  ingest("app", event(subject, type), at(now));
  const job = claimNext("w1", `c${++n}`, at(now))!;
  assert.equal(job?.context.lane, subject, "the round handed out is this matter's");
  return job;
}
/** The worker keeps coming but stops mentioning the run: six minutes on, the hub no longer knows if it's going. */
function lose(run: number, now: number) {
  heartbeat("w1", [], at(now + 6));
  sweep(at(now + 6));
  assert.equal(stateOf(run), "unknown");
}
const stateOf = (run: number) => one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [run])!.state;
const follow = (subject: string) =>
  all<{ key: string; about: string }>("SELECT key, about FROM timers WHERE lane = ? AND event_id IS NULL ORDER BY id", [
    subject,
  ]);
const cards = (subject: string) =>
  all<{ id: number; state: string; to: string | null; title: string; run_id: number }>(
    `SELECT id, state, "to", title, run_id FROM cards WHERE lane = ? AND key NOT LIKE 'run:%' ORDER BY id`,
    [subject],
  );
const told = (run: number) =>
  all<{ key: string; text: string; state: string }>("SELECT key, text, state FROM cards WHERE key = ?", [
    `run:${run}:late`,
  ]);
const offer = (to: string) => ({
  title: `交办给 ${to}`,
  text: "登录页改版",
  options: ["接受", "退回"],
  key: "offer",
  to,
});
const later = (about: string, minutes = 600) => ({ key: "follow", at: new Date(at(minutes)).toISOString(), about });
const done = (receipt: object = {}) => ({ outcome: "done", summary: "办了", ...receipt });

test("a lost round's late look-again doesn't replace the one a newer round booked: one card, one follow-up", () => {
  const { subject, t } = fresh();
  const old = take(subject, t);
  lose(old.run, t);
  const newer = take(subject, t + 7);
  finish(newer.run, newer.token, done({ ask: [offer("bo")], later: [later("等小波")] }), at(t + 8));
  const ack = finish(old.run, old.token, done({ ask: [offer("ada")], later: [later("等阿达")] }), at(t + 9));
  assert.deepEqual(follow(subject), [{ key: "follow", about: "等小波" }]);
  assert.deepEqual(
    cards(subject).map((card) => [card.to, card.state]),
    [["bo", "open"]],
    "only the newer round's card is out",
  );
  assert.deepEqual(
    ack.rejected.map((item) => item.what),
    ["ask", "later"],
  );
  assert.equal(stateOf(old.run), "done", "the old round did end");
});

test("a lost round that was ending the matter can't end the one a newer round began again", () => {
  const { subject, t } = fresh();
  const first = take(subject, t);
  finish(first.run, first.token, done({ ask: [offer("ada")], later: [later("等阿达")] }), at(t + 1));
  const [adas] = cards(subject);
  const ending = take(subject, t + 2, "assign.withdraw");
  lose(ending.run, t + 2);
  const again = take(subject, t + 9);
  const reassigned = { resolve: [{ card: adas.id, reason: "撤回了" }], ask: [offer("bo")], later: [later("等小波")] };
  finish(again.run, again.token, done(reassigned), at(t + 10));
  const ended = { resolve: [{ card: adas.id, reason: "撤回了" }], later: [later("已结束", 60)] };
  finish(ending.run, ending.token, done(ended), at(t + 11));
  assert.deepEqual(follow(subject), [{ key: "follow", about: "等小波" }], "the matter is still followed");
  assert.deepEqual(
    cards(subject).map((card) => [card.to, card.state]),
    [
      ["ada", "closed"],
      ["bo", "open"],
    ],
  );
});

test("a late round whose matter nobody took meanwhile takes effect whole, and no claim leaves a mark in the log", () => {
  const { subject, t } = fresh();
  const before = logAfter(0).length;
  const quiet = take(subject, t);
  lose(quiet.run, t);
  const other = take(`${subject}-other`, t + 7);
  finish(other.run, other.token, done({ later: [later("别的事")] }), at(t + 8));
  const ack = finish(quiet.run, quiet.token, done({ ask: [offer("ada")], later: [later("等阿达")] }), at(t + 9));
  assert.deepEqual(ack.rejected, []);
  assert.deepEqual(follow(subject), [{ key: "follow", about: "等阿达" }]);
  assert.deepEqual(
    cards(subject).map((card) => [card.to, card.state]),
    [["ada", "open"]],
  );
  assert.deepEqual(told(quiet.run), []);
  const runRows = logAfter(before).flatMap((fact) => fact.changes.filter((change) => change.table === "runs"));
  assert.ok(runRows.length > 0);
  assert.ok(
    runRows.every((change) => !change.row || !("passed_by" in change.row)),
    "nothing was passed",
  );
});

test("the same late result handed in again gets the same answer, and nothing happens twice", () => {
  const { subject, t } = fresh();
  const old = take(subject, t);
  lose(old.run, t);
  const newer = take(subject, t + 7);
  finish(newer.run, newer.token, done(), at(t + 8));
  const result = done({ later: [later("等阿达")], notice: [{ title: "看一眼", text: "这个" }] });
  const ack = finish(old.run, old.token, result, at(t + 9));
  const again = finish(old.run, old.token, result, at(t + 10));
  assert.deepEqual(again, { ...ack, duplicate: true });
  assert.equal(ack.rejected.length, 2);
  assert.equal(told(old.run).length, 1);
});

test("a run tried again after failing is the newest round of its matter, not a late one", () => {
  const { subject, t } = fresh();
  const tried = take(subject, t);
  finish(tried.run, tried.token, { outcome: "failed", error: "网络断了" }, at(t + 1));
  const retry = claimNext("w1", `c${++n}`, at(t + 7))!;
  assert.equal(retry.run, tried.run);
  const ack = finish(retry.run, retry.token, done({ ask: [offer("ada")], later: [later("等阿达")] }), at(t + 8));
  assert.deepEqual(ack.rejected, []);
  assert.deepEqual(follow(subject), [{ key: "follow", about: "等阿达" }]);
  assert.equal(cards(subject).length, 1);
});

test("a late round that failed is tried again, says nothing meanwhile, and its next go counts in full", () => {
  const { subject, t } = fresh();
  const old = take(subject, t);
  lose(old.run, t);
  const newer = take(subject, t + 7);
  finish(newer.run, newer.token, done({ later: [later("等小波")] }), at(t + 8));
  const stuck = { outcome: "failed", error: "网络断了", notice: [{ title: "卡住了", text: "网络断了" }] };
  const ack = finish(old.run, old.token, stuck, at(t + 9));
  assert.deepEqual(
    ack.rejected.map((item) => item.what),
    ["notice"],
  );
  assert.deepEqual(cards(subject), []);
  assert.deepEqual(told(old.run), [], "it will run again: nothing is lost, so the owner isn't told");
  assert.equal(stateOf(old.run), "queued");
  const retry = claimNext("w1", `c${++n}`, at(t + 20))!;
  assert.equal(retry.run, old.run);
  assert.deepEqual(finish(retry.run, retry.token, done({ later: [later("等阿达")] }), at(t + 21)).rejected, []);
  assert.deepEqual(follow(subject), [{ key: "follow", about: "等阿达" }]);
});

test("a newer round that was handed out and then failed has still taken the matter from the lost one", () => {
  const { subject, t } = fresh();
  const old = take(subject, t);
  lose(old.run, t);
  const newer = take(subject, t + 7);
  finish(newer.run, newer.token, { outcome: "failed", error: "网络断了" }, at(t + 8));
  const ack = finish(old.run, old.token, done({ later: [later("等阿达")] }), at(t + 9));
  assert.equal(ack.rejected.length, 1);
  assert.deepEqual(follow(subject), []);
  const retry = claimNext("w1", `c${++n}`, at(t + 20))!;
  finish(retry.run, retry.token, done(), at(t + 21));
});

test("a round lost twice over is told of the round that took its matter first, and each later one of its own", () => {
  const { subject, t } = fresh();
  const first = take(subject, t);
  lose(first.run, t);
  const second = take(subject, t + 7);
  lose(second.run, t + 7);
  const third = take(subject, t + 14);
  const late = (job: typeof first, now: number) =>
    finish(job.run, job.token, done({ later: [later("旧的")] }), at(now));
  assert.match(late(first, t + 15).rejected[0].reason, new RegExp(`第 ${second.run} 轮`));
  assert.match(late(second, t + 16).rejected[0].reason, new RegExp(`第 ${third.run} 轮`));
  assert.deepEqual(finish(third.run, third.token, done({ later: [later("新的")] }), at(t + 17)).rejected, []);
  assert.deepEqual(follow(subject), [{ key: "follow", about: "新的" }]);
});

test("a rule without parallel is one matter: a round lost before a newer one was handed out is late", () => {
  const { t } = fresh();
  const old = take("", t, "plain.one");
  lose(old.run, t);
  const newer = take("", t + 7, "plain.two");
  finish(newer.run, newer.token, done({ later: [later("新的")] }), at(t + 8));
  const ack = finish(old.run, old.token, done({ later: [later("旧的")] }), at(t + 9));
  assert.deepEqual(follow(""), [{ key: "follow", about: "新的" }]);
  assert.equal(ack.rejected.length, 1);
  // The timer is gone so the next test on this rule starts clean.
  const tidy = take("", t + 10, "plain.three");
  finish(tidy.run, tidy.token, done({ later: [{ key: "follow", cancel: true }] }), at(t + 11));
});

test("a round of another rule on the same subject, in the same group, hasn't taken the matter", () => {
  const { subject, t } = fresh();
  const quiet = take(subject, t);
  lose(quiet.run, t);
  const peer = take(subject, t + 7, "peer.came");
  finish(peer.run, peer.token, done(), at(t + 8));
  const ack = finish(quiet.run, quiet.token, done({ later: [later("等阿达")] }), at(t + 9));
  assert.deepEqual(ack.rejected, []);
  assert.deepEqual(follow(subject), [{ key: "follow", about: "等阿达" }]);
});

/** A matter with a card out and a look-again booked, then a round lost and a newer one finished plainly. */
function passed() {
  const { subject, t } = fresh();
  const first = take(subject, t);
  finish(first.run, first.token, done({ ask: [offer("ada")], later: [later("等阿达")] }), at(t + 1));
  const [card] = cards(subject);
  const old = take(subject, t + 2);
  lose(old.run, t + 2);
  const newer = take(subject, t + 9);
  finish(newer.run, newer.token, done(), at(t + 10));
  const events = () =>
    all<{ id: number }>("SELECT id FROM events WHERE subject = ? AND type = 'assigned.done'", [subject]);
  return { subject, t: t + 11, old, card, events };
}
const kinds: [string, (card: number, subject: string) => object][] = [
  ["ask", () => ({ ask: [offer("bo")] })],
  ["notice", () => ({ notice: [{ title: "看一眼", text: "这个", fyi: true }] })],
  ["resolve", (card) => ({ resolve: [{ card, reason: "不用了" }] })],
  ["later", () => ({ later: [{ key: "probe", at: new Date(at(900)).toISOString(), about: "再问" }] })],
  ["later", () => ({ later: [later("改了时间")] })],
  ["later", () => ({ later: [{ key: "follow", cancel: true }] })],
  ["events", (_, subject) => ({ events: [{ id: `out-${subject}`, type: "assigned.done", subject }] })],
];
for (const [index, [what, receipt]] of kinds.entries()) {
  test(`a late receipt's ${what} doesn't take effect (${index})`, () => {
    const { subject, t, old, card, events } = passed();
    const ack = finish(old.run, old.token, done(receipt(card.id, subject)), at(t));
    assert.deepEqual(follow(subject), [{ key: "follow", about: "等阿达" }]);
    assert.deepEqual(
      cards(subject).map((each) => [each.id, each.state]),
      [[card.id, "open"]],
    );
    assert.deepEqual(events(), []);
    assert.equal(ack.rejected.length, 1);
    assert.equal(ack.rejected[0].what, what);
    if (what === "resolve") assert.equal(ack.rejected[0].card, card.id);
  });
}

test("a late round's own ending is kept: state, summary, usage, session, the answer it carried out, the rule's every-round note", () => {
  const { t } = fresh();
  const first = take("", t, "plain.one");
  const ask = { title: "要不要回滚", text: "线上报错", options: ["回滚", "再等等"], key: `q${n}` };
  finish(first.run, first.token, done({ ask: [ask] }), at(t + 1));
  const question = one<{ id: number }>("SELECT id FROM cards WHERE run_id = ? AND kind = 'ask'", [first.run])!.id;
  answer(question, { choice: 0, by: "本人" }, at(t + 2));
  const old = claimNext("w1", `c${++n}`, at(t + 2))!;
  lose(old.run, t + 2);
  const newer = take("", t + 9, "plain.two");
  finish(newer.run, newer.token, done(), at(t + 10));
  const result = { ...done({ later: [later("旧的")] }), summary: "照回答办了", session: "s-old", usage: { input: 5 } };
  finish(old.run, old.token, result, at(t + 11));
  const run = one<Record<string, string>>("SELECT state, summary, session, usage, finished_at FROM runs WHERE id = ?", [
    old.run,
  ])!;
  assert.deepEqual(
    { ...run, usage: JSON.parse(run.usage) },
    {
      state: "done",
      summary: "照回答办了",
      session: "s-old",
      usage: { input: 5 },
      finished_at: new Date(at(t + 11)).toISOString(),
    },
  );
  const card = (key: string) =>
    one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE key = ?", [key]);
  assert.deepEqual(one("SELECT state, result FROM cards WHERE id = ?", [question]), {
    state: "done",
    result: "照回答办了",
  });
  assert.equal(card(`run:${old.run}:unknown`)!.state, "closed");
  assert.equal(card(`run:${old.run}:done`)!.state, "closed", "the rule tells of every round done, and this one was");
  assert.deepEqual(follow(""), []);
});

test("what a late receipt lost shows in its answer and in why, and the owner is told once, only when something was lost", () => {
  const { subject, t, old, card } = passed();
  const receipt = { ask: [offer("bo")], resolve: [{ card: card.id, reason: "不用了" }], later: [later("改了")] };
  const ack = finish(old.run, old.token, done(receipt), at(t));
  const newer = old.run + 1;
  for (const item of ack.rejected) assert.match(item.reason, new RegExp(`第 ${newer} 轮`));
  const [notice] = told(old.run);
  assert.equal(notice.state, "open");
  assert.match(notice.text, new RegExp(`第 ${newer} 轮`));
  assert.match(notice.text, /提问 1 张、结案 1 项、复查 1 个/);
  assert.match(notice.text, new RegExp(`agent-autoloop why ${old.run}`));
  const timeline = formatWhy(old.run, why(old.run) as any);
  assert.match(timeline, new RegExp(`这件事交给了第 ${newer} 轮`));
  assert.equal(timeline.match(/未执行：/g)?.length, 3);

  const quiet = passed();
  assert.deepEqual(finish(quiet.old.run, quiet.old.token, done(), at(quiet.t)).rejected, []);
  assert.deepEqual(told(quiet.old.run), [], "it asked for nothing, so nothing was lost");
});

test("a late round's token is still its own: another execution's, or the newer round's, doesn't hand in for it", () => {
  const { subject, t } = fresh();
  const old = take(subject, t);
  lose(old.run, t);
  const newer = take(subject, t + 7);
  assert.throws(() => finish(old.run, newer.token, done(), at(t + 8)), AuthError);
  assert.equal(stateOf(old.run), "unknown");
});
