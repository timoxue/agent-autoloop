import assert from "node:assert/strict";
import { deadlines } from "../kernel/due.ts";
import { snapshot, type Fact, type View, type Row } from "../kernel/evolve.ts";

type Snapshot = ReturnType<typeof snapshot>;
const rows = (view: Snapshot, table: keyof Snapshot["tables"]) => Object.values(view.tables[table]);
// Independent replay oracle: it checks the indexed projection without using its write or query implementation.
export function replay(log: Fact[]): Snapshot {
  const tables = Object.fromEntries(
    [
      "events",
      "runs",
      "run_events",
      "cards",
      "deliveries",
      "timers",
      "schedules",
      "seen",
      "keys",
      "config",
      "due",
      "pauses",
    ].map((t) => [t, {}]),
  ) as Snapshot["tables"];
  const next: Record<string, number> = {};
  let seq = 0;
  for (const fact of log) {
    seq = fact.seq;
    for (const { table, key, row } of fact.changes) {
      if (row === null) delete tables[table][key];
      else {
        tables[table][key] = row;
        // Configuration versions are derived from each rules fact, including logs written before the lookup existed.
        if (table === "config" && key === "rules") tables.config[String(row.version)] = row;
        if (typeof row.id === "number") next[table] = Math.max(next[table] ?? 0, row.id);
      }
    }
  }
  return { seq, tables, next };
}
/** What came in on a key that was taken back or replaced, or on a link that no longer opens its card, must not have
 * been decided. Whether it was good is the caller's own record of what it issued, not anything the hub says. */
export function admitted(good: boolean) {
  assert.ok(good, "用已经作废的密钥或打不开的链接提交成了");
}
export function invariants(current: View, log: Fact[], before?: Snapshot) {
  const view = snapshot(current);
  assert.deepEqual(view, replay(log), "日志重放记录不同");
  for (const [index, fact] of log.entries()) assert.equal(fact.seq, index + 1, "日志序号不连续");
  const events = rows(view, "events");
  const runs = rows(view, "runs");
  const cards = rows(view, "cards");
  const links = rows(view, "run_events");
  assert.equal(new Set(events.map((e) => JSON.stringify([e.source, e.key]))).size, events.length, "重复事件");
  const held = runs.filter((r) => r.state === "claimed");
  assert.equal(new Set(held.map((r) => JSON.stringify([r.grp, r.lane]))).size, held.length, "同一事项同时领了两轮");
  for (const group of new Set(held.map((r) => r.grp)))
    assert.ok(
      held.filter((r) => r.grp === group).length <=
        (view.tables.config.rules.value.rules.find((r: Row) => r.group === group)?.parallel ?? 1),
      "超出同组并发数",
    );
  for (const e of events)
    // A rule paused when the event came is on record as having matched it, and took nothing.
    for (const rule of JSON.parse(e.routed).filter((r: string) => !JSON.parse(e.paused ?? "[]").includes(r)))
      assert.ok(
        links.some((l) => l.event_id === e.id && view.tables.runs[l.run_id]?.rule === rule),
        "已收事件丢了派发关系",
      );
  // What a member sent: kept under their id and at the top of its chain; and whenever a rule took it, as it came or on
  // a replay, the rules as they stood then registered the sender and had that rule take from them. Read from the log,
  // fact by fact, as the rules change.
  let config: Row | undefined;
  const takes = (name: string, from: string) => {
    const when = config?.rules.find((r: Row) => r.name === name)?.when;
    const named = when?.source === "people" && (when.from ?? ["*"]).some((id: string) => id === "*" || id === from);
    return named && Object.hasOwn(config?.people ?? {}, from);
  };
  const sent = new Map<number, Row>();
  for (const fact of log) {
    for (const { table, key, row } of fact.changes) {
      if (table === "config" && key === "rules") config = row!.value;
      // What the clock makes happen is the hub's own to record: nothing that came through a source's or a member's door.
      if (table === "events" && row?.source === "schedule")
        assert.ok(fact.type !== "ingest" && fact.type !== "say", "来源的门记下了定时的事件");
      if (table === "events" && row?.from !== undefined && !sent.has(row.id)) {
        sent.set(row.id, row);
        assert.ok(
          row.source === "people" && row.key.startsWith(`from:${row.from}:`) && row.hops === 0,
          "成员消息记错了",
        );
        for (const name of JSON.parse(row.routed).filter((r: string) => !JSON.parse(row.paused ?? "[]").includes(r)))
          assert.ok(takes(name, row.from), "成员消息派给了不收这个发件人的规则");
      }
      if (fact.type === "replayRule" && table === "run_events" && row && sent.has(row.event_id)) {
        const rule = fact.changes.find((c) => c.table === "runs" && c.row?.id === row.run_id)?.row?.rule;
        assert.ok(
          takes(rule ?? view.tables.runs[row.run_id]?.rule, sent.get(row.event_id)!.from),
          "补跑接了不该接的成员消息",
        );
      }
    }
  }
  for (const card of cards)
    if (card.answer_event !== null) {
      // Whoever a card is for is the one who decided it: not the owner, a link, or someone else on the channel.
      if (card.to !== undefined) assert.equal(card.by, card.to, "写了收件人的卡片被别人回答了");
      const event = view.tables.events[card.answer_event];
      assert.equal(event?.type, "card.answered");
      if (view.tables.config.rules.value.rules.some((r: Row) => r.name === card.rule))
        assert.ok(
          links.some(
            (l) =>
              l.event_id === card.answer_event &&
              view.tables.runs[l.run_id]?.rule === card.rule &&
              view.tables.runs[l.run_id]?.lane === card.lane,
          ),
          "回答没叫醒原事项",
        );
    }
  if (before) {
    for (const e of rows(before, "events")) assert.deepEqual(view.tables.events[e.id], e, "已落盘事件被改了或丢了");
    for (const c of rows(before, "cards"))
      if (c.answer_event !== null) {
        const now = view.tables.cards[c.id];
        assert.equal(now.answer_event, c.answer_event);
        assert.equal(now.choice, c.choice);
        assert.equal(now.answer, c.answer);
      }
    for (const r of rows(before, "runs"))
      if (["done", "nothing", "cancelled"].includes(r.state))
        assert.deepEqual(view.tables.runs[r.id], r, "完成的回执再次生效");
  }
  if (log.length) assert.deepEqual(view.tables.due, deadlines(current, log.at(-1)!.at), "到期表和重算的不一样");
  return view;
}
