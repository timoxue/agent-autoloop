// Failure modes: faults lose accepted events, duplicate execution or answers, exceed parallel limits, change receipts,
// diverge from replay, or strand work after recovery; an enumerator silently skips one ordering; mutation checks do not run;
// a card for someone decided by anyone else goes unnoticed; a member's message recorded as someone else's, or handed to
// a rule that doesn't take it from them, goes unnoticed; the simulation never has a member look, answer or speak, or the
// rules never change under what's in flight (someone taken out, an Agent moved to another machine, a pause and a
// replay), so what goes by the rules of an earlier moment is never met; a replay that hands over a message from someone
// the rules no longer take it from goes unnoticed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../sim/random.ts";
import { enumerate } from "../sim/enumerate.ts";
import { World } from "../sim/world.ts";
import { AuthError } from "../kernel/errors.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { invariants } from "../sim/invariants.ts";

test("200000 deterministic fault steps preserve safety and recovered work terminates", () => {
  const result = simulate(0x5eed, 200000);
  assert.equal(result.steps, 200000);
  for (const fault of ["lost", "duplicate", "restart", "offline", "channel", "clock", "member", "rules"])
    assert.ok(result.faults[fault] > 0, fault);
  assert.ok(result.completed > 0);
  console.log(JSON.stringify(result));
});

test("bounded exhaustive schedules use two workers, two events and one card", () => {
  const result = enumerate();
  assert.equal(result.paths, 40320);
  assert.equal(result.actions, 8);
  assert.ok(result.transitions >= 40320 * 8);
  console.log(JSON.stringify(result));
});

test("the simulator rejects a hub that refuses valid receipt replays", () => {
  const original = World.prototype.call;
  World.prototype.call = function (type: string, ...args: any[]) {
    const run = this.view.get("runs", args[0])!;
    if (type === "finish" && run?.last_issued && run.issued === null) throw new AuthError("故意拒绝有效重放");
    return original.call(this, type, ...args);
  };
  try {
    assert.throws(() => simulate(24301, 2048), /种子/);
  } finally {
    World.prototype.call = original;
  }
});

test("answer checks reject a run in the wrong subject lane", () => {
  const w = new World();
  w.call("createCard", {
    key: "q",
    kind: "ask",
    title: "选",
    options: ["甲", "乙"],
    rule: "one",
    lane: "#1",
    grp: "shared",
    source: "app",
  });
  w.call("answer", 1, { choice: 0 });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "runs" && c.row) c.row.lane = "wrong-lane";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /原事项/);
});

test("answer checks reject a card for someone that anyone else decided", () => {
  const w = new World();
  w.call("createCard", {
    key: "q",
    kind: "ask",
    title: "选",
    options: ["甲", "乙"],
    rule: "one",
    lane: "#1",
    grp: "shared",
    source: "app",
    to: "p1",
  });
  w.call("delivered", "team", 1, 1, "m1");
  w.call("answer", 1, { choice: 0, by: "u1", channel: "team", ref: "m1" });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "cards" && c.row?.by) c.row.by = "owner";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /收件人/);
});

test("message checks reject a member's message recorded as someone else's", () => {
  const w = new World();
  w.call("say", "p2", w.keys.p2, { id: "m", type: "said" });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "events" && c.row?.from) c.row.from = "p1";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /成员消息/);
});

test("message checks reject a replay that hands a rule a message its sender is no longer registered for", () => {
  const w = new World();
  w.call("pauseRule", "three", "owner", {});
  const { event } = w.call("say", "p2", w.keys.p2, { id: "m", type: "said" });
  w.change({ ...w.shape, p2: false });
  w.call("resumeRule", "three");
  assert.deepEqual(w.call("replayRule", "three", [event]).events, []);
  // As a hub that didn't look would have left it: a replay taken while p2 was still there, put after p2 was taken out.
  const loose = new World();
  loose.call("pauseRule", "three", "owner", {});
  loose.call("say", "p2", loose.keys.p2, { id: "m", type: "said" });
  loose.call("resumeRule", "three");
  loose.call("replayRule", "three", [event]);
  const log = structuredClone(loose.log);
  const gone = structuredClone(w.log.find((f) => f.type === "rules" && f.seq > 1)!);
  const replayed = log.pop()!;
  log.push({ ...gone, seq: replayed.seq }, { ...replayed, seq: replayed.seq + 1 });
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /补跑/);
});

test("the simulation catches omitted deadlines that strand deferred work", () => {
  const original = World.prototype.act;
  World.prototype.act = function (input) {
    const value = original.call(this, input);
    this.log = this.log.map((f) => ({ ...f, changes: f.changes.filter((c) => c.table !== "due") }));
    this.view.close();
    this.view = evolve(empty(), this.log);
    return value;
  };
  try {
    assert.throws(() => simulate(24301, 2048));
  } finally {
    World.prototype.act = original;
  }
});
