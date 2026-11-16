import assert from "node:assert/strict";
import { decide, type Input } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { credential, digest } from "../kernel/credentials.ts";
import { invariants } from "./invariants.ts";

export const environment = { secret: "test-simulation", publicUrl: "https://hub.test" };
/** How the rules file stands: whether p2 is registered, and which machine Agent a runs on. The rest never changes. */
export type Shape = { p2: boolean; aOn: "w1" | "w3" };
const BASE: Shape = { p2: true, aOn: "w1" };
const written = ({ p2, aOn }: Shape) =>
  JSON.stringify({
    timezone: "UTC",
    sources: { app: { name: "来源" } },
    agents: {
      a: { name: "甲", worker: aOn, use: "command", command: ["true"] },
      b: { name: "乙", worker: "w2", use: "command", command: ["true"] },
    },
    channels: { chat: { name: "通道", answerers: ["owner"] }, team: { name: "团队", people: true } },
    // p1 is reached on a channel and w1 is their own machine; p2 by their key alone.
    people: {
      p1: { name: "成员", at: { team: "u1" }, workers: ["w1"] },
      ...(p2 && { p2: { name: "只用密钥的成员" } }),
    },
    rules: [
      {
        name: "one",
        when: { source: "app", types: ["one"] },
        to: "a",
        cwd: "/tmp",
        prompt: "做事",
        group: "shared",
        parallel: 2,
        people: ["*"],
      },
      {
        name: "two",
        when: { source: "app", types: ["two"] },
        to: "b",
        cwd: "/tmp",
        prompt: "做事",
        group: "shared",
        parallel: 2,
      },
      // Members' messages, from p2 alone while p2 is registered, and from p1 alone when not: who it names changes.
      {
        name: "three",
        when: { source: "people", types: ["said"], from: [p2 ? "p2" : "p1"] },
        to: "b",
        cwd: "/tmp",
        prompt: "做事",
        parallel: 2,
      },
    ],
  });
const parsed = new Map<string, ReturnType<typeof parseRules>>();
export function rulesFor(shape: Shape) {
  const text = written(shape);
  if (!parsed.has(text)) parsed.set(text, parseRules(text, 0, "UTC"));
  return parsed.get(text)!;
}
export const rules = rulesFor(BASE);

export class World {
  view = empty();
  log: Fact[] = [];
  checked = snapshot(this.view);
  now = 0;
  transitions = 0;
  /** What the simulation knows by its own count, to hold the hub to: the rules as they stand, each member's working
   * key, which machine took each run, and which made each card for someone. */
  shape = BASE;
  rules = rules;
  keys: Record<string, string | undefined> = {};
  /** The key someone had when they were taken out: it must not work again, then or once they're back. */
  old: Record<string, string> = { p1: "never-a-key", p2: "never-a-key" };
  issued = 0;
  takenBy = new Map<number, string>();
  madeOn = new Map<number, string | undefined>();
  constructor() {
    this.act({ type: "rules", args: [rules] });
    this.key("p1");
    this.key("p2");
  }
  key(person: string) {
    this.keys[person] = `key-${person}-${++this.issued}`;
    this.call("key", "person", person, digest(this.keys[person]!));
  }
  /** The owner rewrites rules.json. Someone taken out loses their key; put back, they're given a new one. */
  change(shape: Shape) {
    const had = this.shape.p2;
    this.shape = shape;
    this.rules = rulesFor(shape);
    this.call("rules", this.rules);
    if (had && !shape.p2) {
      this.old.p2 = this.keys.p2!;
      this.keys.p2 = undefined;
    }
    if (!had && shape.p2) this.key("p2");
  }
  /** Whether rule three takes a message from this sender, as the file is written now. */
  takes(person: string | undefined) {
    return person !== undefined && (this.shape.p2 ? "p2" : "p1") === person;
  }
  claim(worker: string, claim: string) {
    const job = this.call("claimNext", worker, claim);
    if (job) this.takenBy.set(job.run, worker);
    return job;
  }
  /** Hands in a result, and notes which machine made each card for someone that came of it. */
  handIn(id: number, token: string, result: unknown) {
    const ack = this.call("finish", id, token, result);
    for (const c of rows(this.view, "cards", { run_id: id }))
      if (c.to !== undefined && !this.madeOn.has(c.id)) this.madeOn.set(c.id, this.takenBy.get(id));
    return ack;
  }
  act(input: Input) {
    const before = this.checked;
    const d = decide(this.view, input, this.now, environment);
    this.log.push(...d.facts);
    this.view = evolve(this.view, d.facts);
    this.transitions++;
    this.checked = invariants(this.view, this.log, before);
    return d.value;
  }
  call(type: string, ...args: any[]) {
    return this.act({ type, args });
  }
  restart() {
    this.view.close();
    this.view = evolve(empty(), this.log);
    this.checked = invariants(this.view, this.log);
    this.transitions++;
  }
  alarm() {
    if (rows(this.view, "due").some((d) => d.at <= this.now)) this.call("tick");
  }
  advance(ms: number) {
    this.now += ms;
    this.alarm();
  }
  finish(id: number, result: unknown = { outcome: "done" }) {
    const r = this.view.get("runs", id)!;
    return this.call("finish", id, credential(environment, "run", id, r.issued), result);
  }
  recover() {
    // The rules as they first were, and nothing paused: what's left is then finished as it always was.
    this.change(BASE);
    if (this.view.get("pauses", "three")) this.call("resumeRule", "three");
    this.advance(86400000);
    for (const r of rows(this.view, "runs").filter((r) => ["claimed", "unknown"].includes(r.state))) this.finish(r.id);
    this.call("heartbeat", "w1", []);
    this.call("heartbeat", "w2", []);
    this.alarm();
    assert.ok(
      rows(this.view, "timers").every((t) => Date.parse(t.at) > this.now || t.event_id !== null),
      "故障停止后到期任务没被叫醒",
    );
    // A card for someone is theirs alone: they answer it on the message sent to them, or with their own key where no
    // channel reaches them, which the owner's key can't.
    for (const c of rows(this.view, "cards").filter((c) => c.state === "open" && c.kind === "ask")) {
      if (c.to === undefined) this.call("answer", c.id, { choice: 0 });
      else if (c.to === "p2") this.call("answer", c.id, { choice: 0, person: "p2", key: this.keys.p2 });
      else {
        const ref = this.view.get("deliveries", `${c.id}:team`)?.ref ?? `recovery-${c.id}`;
        this.call("delivered", "team", c.id, c.version, ref);
        this.call("answer", c.id, { choice: 0, by: "u1", channel: "team", ref });
      }
    }
    for (let n = 0; n < 100; n++) {
      const job = this.claim(n % 2 ? "w2" : "w1", `recovery-${n}`);
      if (job) this.finish(job.run);
      if (!rows(this.view, "runs").some((r) => ["queued", "claimed", "unknown"].includes(r.state))) break;
    }
    assert.ok(
      rows(this.view, "runs").every((r) => ["done", "nothing", "cancelled"].includes(r.state)),
      "故障停止后仍没结局",
    );
    return rows(this.view, "runs").length;
  }
}
