import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const edits: [string, string, string, string][] = [
  ["event-duplicate", "decide.ts", "if (existing) {", "if (false && existing) {"],
  ["source-boundary", "decide.ts", "rule.when.source === source", "true"],
  ["parallel-lane", "decide.ts", 'id, rule.parallel ? event.subject : "")', 'id, "")'],
  ["session-in-use", "decide.ts", "going.some((other) => (other.session ?? other.resume) === session)", "false"],
  ["resume-after-stop", "decide.ts", 'last?.state !== "cancelled" && ', ""],
  ["group-capacity", "decide.ts", "claimed.filter((other) => other.grp === run.grp).length <", "0 <"],
  ["lane-exclusion", "decide.ts", "!claimed.some((other) => other.grp === run.grp && other.lane === run.lane)", "true"],
  ["worker-boundary", "decide.ts", "!agents.includes(rule.to)", "false"],
  ["retry-delay", "decide.ts", "5 * MINUTE * 2 ** (attempts - 1)", "0 * MINUTE * 2 ** (attempts - 1)"],
  [
    "receipt-replay",
    "decide.ts",
    "if (prior && prior.last_issued !== null &&",
    "if (false && prior && prior.last_issued !== null &&",
  ],
  ["receipt-conflict", "decide.ts", "if (prior.last_result !== hash)", "if (false)"],
  ["run-capability", "decide.ts", 'credential(draft.env, "run", id, run.issued) !== token', "false"],
  ["answer-first", "decide.ts", 'if (card.state !== "open")', "if (false)"],
  ["answer-person", "decide.ts", 'if (allowed && !allowed.includes(given.by ?? ""))', "if (false)"],
  ["answer-message", "decide.ts", "if (!delivery?.ref || delivery.ref !== given.ref)", "if (false)"],
  [
    "answer-wakeup",
    "decide.ts",
    "if (rule) enqueue(draft, rule, eventId, card.lane,",
    "if (false) enqueue(draft, rule, eventId, card.lane,",
  ],
  ["answer-recipient", "decide.ts", "if (address === undefined || given.by !== address)", "if (false)"],
  ["answer-owner-for-person", "decide.ts", "} else if (card.to !== undefined) {", "} else if (false) {"],
  ["answer-kept-as-person", "decide.ts", "const by = card.to ?? given.by ?? null;", "const by = given.by ?? null;"],
  ["link-for-person", "query.ts", 'if (card.to !== undefined) throw new NotFound("没有这张卡片");', ""],
  ["link-none-for-person", "decide.ts", "?.links === true && card.to === undefined;", "?.links === true;"],
  ["deliver-people-channel", "decide.ts", "draft.rules.channels[channel]?.people !== true || !to", "!to"],
  [
    "deliver-person-address",
    "decide.ts",
    "draft.rules.channels[channel]?.people !== true || !to",
    "draft.rules.channels[channel]?.people !== true",
  ],
  ["receipt-people", "decide.ts", "!peopleOf(draft.rules, rule).includes(card.to)", "false"],
  ["card-key-recipient", "decide.ts", "card.to === undefined ? thread : `to:${card.to}:${thread}`", "thread"],
  ["card-key-unambiguous", "decide.ts", "`to:${card.to}:${thread}`", "`${thread}:to:${card.to}`"],
  ["quiet-only-owner", "decide.ts", 'rule?.tell === "never" && card.to === undefined', 'rule?.tell === "never"'],
  ["failing-told-by-own-notice", "decide.ts", "!notice.fyi && notice.to === undefined", "!notice.fyi"],
  ["member-answers-own-only", "decide.ts", 'if (card.to !== given.person) throw new NotFound("没有这张卡片");', ""],
  [
    "member-key-own-doors",
    "http.ts",
    "const holder = enter(call, kind);",
    'const holder = enter(call, kind) ?? enter(call, "person");',
  ],
  ["person-key-registered", "decide.ts", 'if (kind === "person" && !personOf(draft.rules, name)) {', "if (false) {"],
  ["me-only-mine", "query.ts", "const mine = { to: person };", "const mine = {};"],
  ["member-event-sender-kept", "decide.ts", "...(event.from !== undefined && { from: event.from }),", ""],
  ["member-event-own-ids", "decide.ts", "id: `from:${from}:${parsed.id}`", "id: parsed.id"],
  ["member-event-top-of-chain", "decide.ts", "hops: 0, from }", "from }"],
  [
    "member-event-not-sources",
    "decide.ts",
    "ingest(draft, PEOPLE, given, false, person)",
    "ingest(draft, PEOPLE, given, true, person)",
  ],
  [
    "source-door-not-members",
    "decide.ts",
    'if (source === PEOPLE && draft.rules.people !== undefined) throw new AuthError("这个来源名留给成员发的消息");',
    "",
  ],
  ["member-rule-registered", "rules.ts", 'personOf(rules, from ?? "") !== undefined && ', ""],
  ["member-rule-from", "rules.ts", '(id) => id === "*" || id === from', "() => true"],
  ["people-source-only-with-people", "rules.ts", "rules.people === undefined ||", "false ||"],
  [
    "member-own-machine",
    "decide.ts",
    "if (personWorkers(draft.rules, given.person).includes(card.worker)) {",
    "if (false) {",
  ],
  [
    "card-keeps-its-machine",
    "decide.ts",
    "if (personWorkers(draft.rules, given.person).includes(card.worker)) {",
    'if (personWorkers(draft.rules, given.person).includes(workerOf(draft.view, draft.view.get("runs", card.run_id)!))) {',
  ],
  [
    "key-at-commit",
    "decide.ts",
    'if (typeof key !== "string" || whose(draft.view, kind, key) !== name) throw notHolding(kind);',
    "",
  ],
  ["door-key-at-commit", "decide.ts", "if (holder) holding(draft, holder);", ""],
  [
    "member-answer-key-at-commit",
    "decide.ts",
    'if (given.person !== undefined) holding(draft, { kind: "person", name: given.person, key: given.key });',
    "",
  ],
  ["member-say-key-at-commit", "decide.ts", 'holding(draft, { kind: "person", name: person, key });', ""],
  [
    "link-at-commit",
    "decide.ts",
    "return void linkedCard(draft.rules, opens ? card : undefined, draft.now);",
    "return;",
  ],
  [
    "link-known-at-commit",
    "decide.ts",
    'const opens = card && credential(draft.env, "card", card.id, card.created_at) === key;',
    "const opens = card;",
  ],
  ["schedule-source-door", "decide.ts", 'if (source === SCHEDULE) throw new AuthError("这个来源名留给定时");', ""],
  [
    "door-key-goes-along",
    "http.ts",
    "call.services.dispatch(type, args, call.services.now(), call.holder);",
    "call.services.dispatch(type, args, call.services.now());",
  ],
  ["key-let-in-goes-along", "http.ts", "if (name) call.holder = { kind, name, key: call.token };", ""],
  ["link-goes-along", "http.ts", "call.holder = { kind: LINK, name: String(card.id), key: linkToken };", ""],
  [
    "key-name-not-key-kept",
    "http.ts",
    ": act(call, type, name, holder, given);",
    ": act(call, type, name, call.token, given);",
  ],
  [
    "removed-person-key-revoked",
    "decide.ts",
    'if (!personOf(rules, key.name)) set(draft, "keys", `person:${key.name}`, null);',
    "",
  ],
  ["replay-takes-sender", "decide.ts", "if (!takesFrom(draft.rules, rule, event.from)) continue;", ""],
  ["member-answer-as-member", "http.ts", 'theirs || { by: "本人" }', '{ by: "本人" }'],
  [
    "member-sender-from-key",
    "http.ts",
    'return json(act(call, "say", member, token, await readJson(request)));',
    'const { from, ...message } = await readJson(request);\n    return json(act(call, "say", from ?? member, token, message));',
  ],
  ["quiet-delivery", "decide.ts", "if (card.quiet ||", "if (false ||"],
  ["delivery-lease", "decide.ts", "not_before: iso(now + MINUTE)", "not_before: iso(now)"],
  ["delivery-version", "decide.ts", "version: Math.max(delivery.version, version)", "version: version"],
  ["timer-fire", "decide.ts", "Date.parse(timer.at) <= now", "Date.parse(timer.at) > now"],
  [
    "cron-latest",
    "decide.ts",
    "latestBefore(cron, Date.parse(schedule.next_at), now, timezone)",
    "Date.parse(schedule.next_at)",
  ],
  ["retry-deadline", "due.ts", 'if (notBefore > now) add("retry"', 'if (notBefore < now) add("retry"'],
  ["due-after-change", "decide.ts", 'if (!draft.changes.length && type !== "tick")', 'if (type !== "tick")'],
  ["due-at-tick", "decide.ts", 'if (!draft.changes.length && type !== "tick")', "if (!draft.changes.length)"],
  ["offline-hides-new-work", "due.ts", "waiting.every((run) => run.created_at <= card.closed_at)", "true"],
  ["offline-closed-comes-back", "due.ts", "waiting.every((run) => run.created_at <= card.closed_at)", "false"],
  ["link-expiry", "query.ts", "now - Date.parse(card.created_at) > LINK_LIFETIME", "false"],
  ["links-in-use", "query.ts", "if (!card || !linksInUse)", "if (!card)"],
  ["projection-drop", "evolve.ts", "if (row === null)", 'if (row === null || table === "cards")'],
  ["log-order", "store.ts", "ORDER BY seq", "ORDER BY seq DESC"],
  ["stale-commit", "store.ts", "if (latest !== view.seq)", "if (false)"],
  ["log-append", "store.ts", "for (const fact of facts) insert.run", "for (const fact of []) insert.run"],
  ["transaction-removed", "store.ts", "return transaction(db, () => {", "return ((work) => work())(() => {"],
];
const tests = [
  "kernel",
  "events",
  "cards",
  "runs",
  "schedule",
  "stream",
  "purity",
  "queue-costs",
  "http",
  "resume-thread",
  "people",
  "member",
  "commit-auth",
].map((n) => `tests/${n}.test.ts`);
export function mutate() {
  const root = join(import.meta.dirname, "..");
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-mutation-"));
  // An inherited test-runner context bypasses the child CLI's test selection.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", ...tests], {
      cwd: folder,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
  try {
    // All of it: a test that reads a folder left out here fails the baseline here and nowhere else (#119, then #128).
    for (const name of readdirSync(root).filter((name) => ![".git", ".claude", "node_modules"].includes(name)))
      cpSync(join(root, name), join(folder, name), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(folder, "node_modules"));
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.ok(Number(/# tests (\d+)/.exec(baseline.stdout)?.[1]) > 50, "基线必须确实执行行为测试");
    const mutations = edits.map(([name, file, before, after]) => ({
      name,
      file,
      change: (text: string) => {
        assert.ok(text.includes(before), name);
        // Everywhere: a guard that's written twice, as the store's transaction is, stands if only one is taken away.
        return text.replaceAll(before, after);
      },
    }));
    const survived: string[] = [];
    const invalid: string[] = [];
    let killed = 0;
    for (const mutation of mutations) {
      const file = join(folder, "kernel", mutation.file);
      const original = readFileSync(file, "utf8");
      try {
        writeFileSync(file, mutation.change(original));
        const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        if (syntax.status !== 0) {
          invalid.push(mutation.name);
          continue;
        }
        const result = run();
        if (result.status === 0) survived.push(mutation.name);
        else {
          assert.ok(!result.error, `${mutation.name}: ${result.error}`);
          killed++;
        }
        console.log(`${mutation.name}: ${result.status === 0 ? "漏过" : "抓到"}`);
      } finally {
        writeFileSync(file, original);
      }
    }
    return { total: mutations.length, killed, survived, invalid, ratio: killed / mutations.length };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
if (import.meta.main) console.log(JSON.stringify(mutate(), null, 2));
