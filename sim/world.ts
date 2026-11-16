import assert from "node:assert/strict";
import { decide, type Input } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { credential, digest } from "../kernel/credentials.ts";
import { admitted, invariants, settled } from "./invariants.ts";

export const environment = { secret: "test-simulation", publicUrl: "https://hub.test" };
/** How the rules file stands: whether p2 is registered, which machine Agent a runs on, and whether the owner's channel
 * takes links. The rest never changes. */
export type Shape = { p2: boolean; aOn: "w1" | "w3"; links: boolean };
const BASE: Shape = { p2: true, aOn: "w1", links: true };
/** How long a card's link opens it, by the protocol's word. */
const WEEK = 7 * 86400000;
/** What only the owner's key asks for. */
const OWNERS = ["pauseRule", "resumeRule", "replayRule", "runRule", "cancel", "resolve", "removeKey"];
const written = ({ p2, aOn, links }: Shape) =>
  JSON.stringify({
    timezone: "UTC",
    sources: { app: { name: "来源" } },
    agents: {
      a: { name: "甲", worker: aOn, use: "command", command: ["true"] },
      b: { name: "乙", worker: "w2", use: "command", command: ["true"] },
    },
    channels: {
      chat: { name: "通道", answerers: ["owner"], ...(links && { links: true }) },
      team: { name: "团队", people: true },
    },
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
        // A type no rule takes: what a receipt sends is recorded and starts nothing.
        emits: { source: "app", types: ["made"] },
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
  /** The key each door goes by, under `kind:name`, as the simulation issued it: the one that works now, and one that
   * did before it was taken back or replaced. An owner, a source, a worker or a channel gets one when it first acts. */
  held: Record<string, string | undefined> = {};
  dead: Record<string, string> = {};
  issued = 0;
  /** By the claims the simulation itself saw answered, in the order it saw them: the round each matter was handed to
   * last, and for a round whose matter has been handed out again since, the first round it went to. And how many
   * receipts came in from such a round asking for something. */
  lead = new Map<string, number>();
  passer = new Map<number, number>();
  /** The rounds that handed in after being passed: nothing they took may still be theirs. */
  voided = new Set<number>();
  late = 0;
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
  /** A new key for this door: the one it had, if any, is dead from here on. */
  issue(kind: string, name: string) {
    const id = `${kind}:${name}`;
    if (this.held[id]) this.dead[id] = this.held[id]!;
    this.held[id] = `key-${id}-${++this.issued}`;
    this.act({ type: "key", args: [kind, name, digest(this.held[id]!)] });
    return this.held[id]!;
  }
  /** The owner takes a door's key back, with the owner's own key while it still works. */
  revoke(kind: string, name: string) {
    const id = `${kind}:${name}`;
    this.call("removeKey", kind, name);
    this.dead[id] = this.held[id]!;
    this.held[id] = undefined;
  }
  /** What a card's link is made from. */
  link(card: { id: number; created_at: string }) {
    return credential(environment, "card", card.id, card.created_at);
  }
  /** Whose door an input comes through, when it's a key's: a member's key goes in the input itself. */
  door(type: string, args: any[]): [string, string] | undefined {
    if (type === "ingest") return ["source", args[0]];
    if (type === "heartbeat" || type === "claimNext") return ["worker", args[0]];
    if (["nextCard", "channelSeen", "delivered", "failed"].includes(type)) return ["channel", args[0]];
    if (type === "answer" && args[1]?.channel !== undefined) return ["channel", args[1].channel];
    if (type === "answer" && args[1]?.person === undefined) return ["owner", "owner"];
    if (OWNERS.includes(type)) return ["owner", "owner"];
  }
  /** Whether what an input came in on is good at this moment, by the simulation's own record and nothing of the hub's:
   * the key issued last and not taken back, or a link to a card of the owner's while links are taken and its week lasts. */
  good({ type, args, holder }: Input) {
    if (type === "say" && this.keys[args[0]] !== args[1]) return false;
    if (type === "answer" && args[1]?.person !== undefined && this.keys[args[1].person] !== args[1].key) return false;
    if (!holder) return true;
    if (holder.kind !== "link") return this.held[`${holder.kind}:${holder.name}`] === holder.key;
    const card = this.view.get("cards", Number(holder.name));
    const lasts = card && this.now - Date.parse(card.created_at) <= WEEK;
    return !!lasts && this.shape.links && card.to === undefined && holder.key === this.link(card as any);
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
  /** The matter a run is of. */
  matter(id: number) {
    const run = this.view.get("runs", id);
    return run && `${run.rule}\n${run.lane}`;
  }
  act(input: Input) {
    const before = this.checked;
    const good = this.good(input);
    const [id, , result] = input.args;
    // Before the hub decides: which round, if any, this one's matter has been handed to since.
    const passed = input.type === "finish" ? this.passer.get(id) : undefined;
    const d = decide(this.view, input, this.now, environment);
    admitted(good);
    this.log.push(...d.facts);
    this.view = evolve(this.view, d.facts);
    this.transitions++;
    if (input.type === "claimNext" && d.value) {
      const { run } = d.value;
      const last = this.lead.get(this.matter(run)!);
      // What it had taken went on with its matter: there's nothing for it to be handed out again with.
      assert.ok(!this.passer.has(run), "被接手的一轮又被派了出去");
      if (last !== undefined && last !== run && !this.passer.has(last)) this.passer.set(last, run);
      this.lead.set(this.matter(run)!, run);
    }
    if (input.type === "finish" && !d.value.duplicate) {
      settled(d.facts, before, id, passed, result, d.value);
      if (passed !== undefined) this.voided.add(id);
      if (passed && ["ask", "notice", "resolve", "later", "events"].some((what) => result[what]?.length)) this.late++;
    }
    this.checked = invariants(this.view, this.log, before, this.voided);
    return d.value;
  }
  /** An input through its door, with the key that door goes by now. What the hub does of itself has none. */
  call(type: string, ...args: any[]) {
    const door = this.door(type, args);
    // The clock's source is nobody's to hold a key for.
    if (!door || door.join(":") === "source:schedule") return this.act({ type, args });
    const [kind, name] = door;
    const key = this.held[door.join(":")] ?? this.issue(kind, name);
    return this.act({ type, args, holder: { kind, name, key } });
  }
  /** An input that came in on this key or link, good or not. */
  callAs(holder: { kind: string; name: string; key: string }, type: string, ...args: any[]) {
    return this.act({ type, args, holder });
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
