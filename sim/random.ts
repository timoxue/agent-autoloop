import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { rows } from "../kernel/evolve.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import { credential } from "../kernel/credentials.ts";
import { mineOf } from "../kernel/query.ts";
import { World, environment } from "./world.ts";

export function random(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
export function simulate(seed = 0x5eed, steps = 200000) {
  const rng = random(seed);
  const start = performance.now();
  const faults: Record<string, number> = {
    lost: 0,
    duplicate: 0,
    restart: 0,
    offline: 0,
    channel: 0,
    clock: 0,
    member: 0,
    rules: 0,
    keys: 0,
    link: 0,
    late: 0,
    passed: 0,
  };
  let world = new World();
  let completed = 0;
  const receipts: { id: number; token: string; body: object; ack: object }[] = [];
  /** What a round hands in: it failed, or it ended, sometimes asking the hub for some of everything a receipt can. */
  const receipt = (r: { id: number; grp: string; claimed_at: string }, how?: "failed" | "asking") => {
    if (how === "failed" || (!how && rng(4) === 0))
      // A run that didn't get through may still tell someone, and is then tried again, perhaps on another machine.
      return {
        outcome: "failed",
        ...(rng(2) === 0 && { notice: [{ title: "卡住了", text: "内容", key: `stuck-${r.id}`, to: "p1" }] }),
      };
    if (!how && rng(3) !== 0) return { outcome: "done" };
    // Rule one may name p1, rule two no one: there it's turned down and no card is made.
    const ask = { title: "选择", text: "内容", options: ["甲", "乙"], key: `card-${r.id}` };
    const open = rows(world.view, "cards").filter((c) => c.state === "open");
    // One it may close, when there is one: its group's, from its source, there before it was handed out.
    const near = open.filter((c) => c.grp === r.grp && c.source === "app" && c.created_at <= r.claimed_at);
    const card = (near.length ? near : open)[rng(Math.max(near.length || open.length, 1))];
    // One look-again to a matter, under one name: booked, moved, or cancelled.
    const later = rng(4)
      ? { at: new Date(world.now + 60000 + rng(60000)).toISOString(), about: "复查" }
      : { cancel: true };
    return {
      outcome: "done",
      ...(rng(2) && { ask: [{ ...ask, ...(rng(2) && { to: rng(2) ? "p1" : "p2" }) }] }),
      ...(rng(3) === 0 && { notice: [{ title: "看一眼", text: "内容", key: `note-${r.id}`, fyi: rng(2) === 0 }] }),
      ...(rng(2) && card && { resolve: [{ card: card.id, reason: "核实过了" }] }),
      ...(rng(4) && { later: [{ key: "follow", ...later }] }),
      // Rule one may send this type, and nothing takes it.
      ...(rng(3) === 0 && { events: [{ id: `made-${r.id}-${rng(4)}`, type: "made", subject: `#${rng(4)}` }] }),
    };
  };
  const handIn = (r: { id: number; grp: string; claimed_at: string; issued: number }, how?: "failed" | "asking") => {
    const body = receipt(r, how);
    const token = credential(environment, "run", r.id, r.issued);
    const ack = world.handIn(r.id, token, body);
    receipts.push({ id: r.id, token, body, ack });
  };
  for (let step = 0; step < steps; step++) {
    try {
      if (step && step % 128 === 0) {
        completed += world.recover();
        faults.passed += world.late;
        world.view.close();
        world = new World();
        receipts.length = 0;
      }
      world.advance(rng(30000));
      const op = rng(18);
      const live = rows(world.view, "runs").filter((r) => ["claimed", "unknown"].includes(r.state));
      if (op < 3) {
        const id = String(rng(16));
        const args = ["app", { id, type: rng(2) ? "one" : "two", subject: `#${rng(4)}` }];
        world.call("ingest", ...args);
        if (op === 0) {
          faults.duplicate++;
          assert.equal(world.call("ingest", ...args).duplicate, true);
        }
      } else if (op === 3 || op === 4) {
        // Agent a's machine is w1 or w3, as the rules stand; a machine reports the runs it took.
        const worker = ["w1", "w2", "w3"][rng(3)];
        const claim = `claim-${rng(4)}`;
        world.call(
          "heartbeat",
          worker,
          live.filter((r) => world.takenBy.get(r.id) === worker && rng(3) !== 0).map((r) => r.id),
        );
        world.alarm();
        const job = world.claim(worker, claim);
        if (op === 4 && job) {
          faults.lost++;
          const again = world.claim(worker, claim);
          assert.equal(again.run, job.run);
        }
      } else if (op === 5 && live.length) {
        handIn(live[rng(live.length)] as any);
      } else if (op === 17) {
        faults.late++;
        // A round its machine stops mentioning while it keeps coming: six minutes on the hub no longer knows if it's
        // going, and lets its group go on. Then something comes in for the same matter, or for another subject of its
        // rule, or for the other rule on its subject, and whoever can takes it. The lost round hands in after that, now
        // or whenever its turn comes: only where its own matter went to a newer round has it been passed.
        const held = live.filter((r) => r.state === "claimed" && r.rule !== "three");
        const lost = held[rng(Math.max(held.length, 1))];
        if (lost) {
          const machine = world.takenBy.get(lost.id)!;
          const others = live.filter((r) => r.id !== lost.id && world.takenBy.get(r.id) === machine).map((r) => r.id);
          world.advance(360000);
          world.call("heartbeat", machine, others);
          world.alarm();
          const where = rng(3);
          const subject = where === 1 ? `#${rng(4)}` : lost.lane;
          const type = where === 2 ? (lost.rule === "one" ? "two" : "one") : lost.rule;
          world.call("ingest", "app", { id: `again-${step}`, type, subject });
          // Each machine takes what it's given, older work first, until it has the round for what just came in.
          const came = world.matter(rows(world.view, "runs", { state: "queued" }).at(-1)?.id ?? 0);
          for (const worker of ["w1", "w2", "w3"]) {
            world.call("heartbeat", worker, worker === machine ? others : []);
            for (let n = 0; n < 3; n++) {
              const job = world.claim(worker, `again-${step}-${worker}-${n}`);
              if (!job || world.matter(job.run) === came) break;
            }
          }
          const now = world.view.get("runs", lost.id)!;
          // Asking for something, mostly; or failed, to be tried again as the newest round of its matter.
          const how = ([undefined, "failed", "asking", "asking"] as const)[rng(4)];
          if (rng(2) && ["claimed", "unknown"].includes(now.state)) handIn(now as any, how);
        }
      } else if (op === 6 && receipts.length) {
        faults.lost++;
        const r = receipts[rng(receipts.length)];
        const current = world.view.get("runs", r.id);
        const valid =
          current?.last_issued !== null &&
          current &&
          credential(environment, "run", r.id, current.last_issued) === r.token;
        if (valid) assert.deepEqual(world.call("finish", r.id, r.token, r.body), { ...r.ack, duplicate: true });
        else assert.throws(() => world.call("finish", r.id, r.token, r.body), AuthError);
      } else if (op === 7) {
        faults.restart++;
        world.restart();
      } else if (op === 8) {
        faults.offline++;
        world.advance(700000);
      } else if (op === 9) {
        faults.channel++;
        // The owner's channel, or the one that sends by recipient, where whoever a card is for answers it, and only they.
        const channel = rng(2) ? "chat" : "team";
        const card = world.call("nextCard", channel);
        if (card) {
          if (rng(2)) world.call("failed", channel, card.id, card.version, "模拟断线");
          else {
            world.call("delivered", channel, card.id, card.version, `message-${card.id}`);
            const by = channel === "chat" ? "owner" : rng(4) ? "u1" : "u2";
            const given = { choice: 0, by, channel, ref: `message-${card.id}` };
            if (card.to && by !== card.to.address) assert.throws(() => world.call("answer", card.id, given), AuthError);
            else if (card.state === "open") world.call("answer", card.id, given);
          }
        }
      } else if (op === 10) {
        faults.clock++;
        world.advance(-rng(120000));
      } else if (op === 12) {
        faults.member++;
        // A member with their own key: what they're shown is theirs alone, and they answer only what's for them, never
        // what their own machine made, by the simulation's own note of which machine that was. Taken out of the rules,
        // their key is nobody's.
        const person = rng(2) ? "p1" : "p2";
        const key = world.keys[person];
        if (key) {
          const shown = mineOf(world.view, world.rules, environment, person);
          for (const c of [...shown.cards, ...shown.recentCards])
            assert.equal(world.view.get("cards", c.id)!.to, person, "成员看到了不是发给他的卡片");
        }
        // A question, or a notice for someone, which a run that failed can send too before it's tried again elsewhere.
        const asks = rows(world.view, "cards").filter((c) => c.kind === "ask" || c.to !== undefined);
        const card = asks[rng(asks.length)];
        const given = { choice: rng(2), person, key: key ?? world.old[person] };
        if (card && rng(4) === 0)
          assert.throws(() => world.call("answer", card.id, { ...given, key: world.old[person] }), AuthError);
        const own: (string | undefined)[] = world.rules.people![person]?.workers ?? [];
        if (!card) world.alarm();
        else if (!key) assert.throws(() => world.call("answer", card.id, given), AuthError);
        else if (card.to !== person) assert.throws(() => world.call("answer", card.id, given), NotFound);
        else if (own.includes(world.madeOn.get(card.id)))
          assert.throws(() => world.call("answer", card.id, given), AuthError);
        else assert.equal(world.call("answer", card.id, given).changed, card.state === "open");
      } else if (op === 13) {
        faults.member++;
        // A member says something: only a rule that takes it from them gets it, now or held by its pause, and said
        // again it's the same event.
        const person = rng(2) ? "p1" : "p2";
        const key = world.keys[person];
        const message = { id: String(rng(8)), type: "said", subject: `#${rng(4)}`, hops: rng(12) };
        if (!key) assert.throws(() => world.call("say", person, world.old[person], message), AuthError);
        else {
          const first = world.call("say", person, key, message);
          if (!first.duplicate) {
            const taken = world.takes(person) ? ["three"] : [];
            const paused = world.view.get("pauses", "three") ? taken : [];
            assert.deepEqual([first.routed, first.paused], [paused.length ? [] : taken, paused]);
          }
          assert.deepEqual(world.call("say", person, key, message), { ...first, duplicate: true });
        }
      } else if (op === 14) {
        faults.rules++;
        // The rules change under what's in flight: someone is taken out or put back, an Agent moves to another machine,
        // the rule for members' messages is paused, resumed, or handed what its pause skipped.
        const change = rng(5);
        if (change === 4) world.change({ ...world.shape, links: !world.shape.links });
        else if (change === 0) world.change({ ...world.shape, p2: !world.shape.p2 });
        else if (change === 1) world.change({ ...world.shape, aOn: world.shape.aOn === "w1" ? "w3" : "w1" });
        else if (!world.view.get("pauses", "three")) {
          if (change === 2) world.call("pauseRule", "three", "owner", {});
          else {
            const skipped = rows(world.view, "events").filter((e) => JSON.parse(e.paused ?? "[]").includes("three"));
            const again = world.call(
              "replayRule",
              "three",
              skipped.map((e) => e.id),
            );
            for (const id of again.events)
              assert.ok(world.takes(world.view.get("events", id)!.from), "补跑接了现在不收的发件人的消息");
          }
        } else world.call("resumeRule", "three");
      } else if (op === 15) {
        faults.keys++;
        // A door's key is taken back, or replaced by a new one under the same name, and what then comes in on the old
        // one is refused whatever it asks for: by the simulation's own record of which key it issued last. Taken back,
        // the door is given a new one before anyone else acts.
        const doors = [
          "owner:owner",
          "source:app",
          "worker:w1",
          "worker:w2",
          "worker:w3",
          "channel:chat",
          "channel:team",
        ];
        const [kind, name] = doors[rng(doors.length)].split(":");
        const id = `${kind}:${name}`;
        if (!world.held[id]) world.issue(kind, name);
        if (rng(2)) world.revoke(kind, name);
        else world.issue(kind, name);
        const cards = rows(world.view, "cards");
        const card = cards[rng(cards.length)]?.id ?? 1;
        const run = rows(world.view, "runs")[0]?.id ?? 1;
        const asked: Record<string, [string, ...any[]][]> = {
          owner: [
            ["answer", card, { choice: 0 }],
            ["resolve", card, "不用了", "本人"],
            ["cancel", run],
            ["pauseRule", "three", "owner", {}],
            ["resumeRule", "three"],
            ["runRule", "one", "owner", {}],
            ["replayRule", "three", []],
            ["removeKey", "source", "app"],
          ],
          source: [["ingest", name, { id: `late-${step}`, type: "one", subject: "#0" }]],
          worker: [
            ["heartbeat", name, live.map((r) => r.id)],
            ["claimNext", name, `late-${step}`],
          ],
          channel: [
            ["channelSeen", name],
            ["nextCard", name],
            ["delivered", name, card, 1, `late-${card}`],
            ["failed", name, card, 1, "模拟断线"],
            [
              "answer",
              card,
              { choice: 0, by: name === "chat" ? "owner" : "u1", channel: name, ref: `message-${card}` },
            ],
          ],
        };
        const [type, ...args] = asked[kind][rng(asked[kind].length)];
        // The one just taken back or replaced, or one that died before it.
        const key = rng(4) ? world.dead[id] : `key-${id}-${rng(world.issued) + 1}`;
        if (key !== world.held[id]) assert.throws(() => world.callAs({ kind, name, key }, type, ...args), AuthError);
        if (!world.held[id]) world.issue(kind, name);
      } else if (op === 16) {
        faults.link++;
        // A card's link: it answers a card of the owner's while some channel takes links and its week lasts, by the
        // simulation's own reading of the rules it wrote and of what the link is made from. It may have stopped taking
        // links since the card went out, and a link made up, or to a card for someone, opens nothing.
        const asks = rows(world.view, "cards").filter((c) => c.kind === "ask");
        const card = asks[rng(asks.length)];
        // What the clock's source records is the hub's own: a source's key by that name gets nothing in.
        const moment = { id: `one@${new Date(world.now).toISOString()}`, type: "schedule.tick" };
        assert.throws(() => world.call("ingest", "schedule", moment), AuthError);
        if (card) {
          const key = rng(3) ? world.link(card as any) : "made-up";
          const given = { choice: rng(2), by: "链接" };
          const holder = { kind: "link", name: String(card.id), key };
          if (world.good({ type: "answer", args: [card.id, given], holder }))
            assert.equal(world.callAs(holder, "answer", card.id, given).changed, card.state === "open");
          else
            assert.throws(
              () => world.callAs(holder, "answer", card.id, given),
              (e) => e instanceof AuthError || e instanceof NotFound,
            );
        }
      } else {
        const card = rows(world.view, "cards").find((c) => c.kind === "ask");
        if (card?.to !== undefined) assert.throws(() => world.call("answer", card.id, { choice: rng(2) }), AuthError);
        else if (card) {
          world.call("answer", card.id, { choice: rng(2) });
          world.call("answer", card.id, { choice: rng(2) });
        } else world.alarm();
      }
    } catch (error) {
      throw new Error(`种子 ${seed}，第 ${step} 步；node sim/random.ts ${seed} ${step + 1}`, { cause: error });
    }
  }
  completed += world.recover();
  faults.passed += world.late;
  world.view.close();
  const ms = performance.now() - start;
  return { seed, steps, epoch: 128, faults, completed, ms, stepsPerSecond: Math.round((steps * 1000) / ms) };
}
if (import.meta.main)
  console.log(JSON.stringify(simulate(Number(process.argv[2] ?? 0x5eed), Number(process.argv[3] ?? 200000)), null, 2));
