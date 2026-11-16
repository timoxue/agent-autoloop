// `rules explain` and `emit --dry-run`: what this machine's rules file says, without asking a hub or writing a fact.
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, PEOPLE, peopleOf, SCHEDULE, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (zone: string) =>
  ({ timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) as const;
const when = (rule: Rule, rules: Rules, now: number) =>
  eventRule(rule)
    ? `来源 ${rule.when.source} · ${rule.when.types.join("、")}${rule.when.from ? ` · 只收 ${rule.when.from.join("、")} 发的` : ""}`
    : `定时 ${describeCron(cronOf(rule))}（下次 ${new Date(
        nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!,
      ).toLocaleString("zh-CN", clock(rules.timezone))}）`;

function details(rule: Rule, rules: Rules, now: number) {
  const parts = [when(rule, rules, now), `→ ${rule.to}`, rule.cwd];
  if (rule.parallel) parts.push(`并发 ${rule.parallel}`);
  if (rule.maxActive) parts.push(`本规则最多同时 ${rule.maxActive} 轮`);
  if (rule.channels?.length) parts.push(`只发 ${rule.channels.join("、")}`);
  if (rule.resume) parts.push("接着上一轮的会话");
  if (rule.title) parts.push(`会话标题 ${rule.title}`);
  if (rule.group !== rule.name) parts.push(`组 ${rule.group}`);
  if (rule.tell !== "needed") parts.push(`通知 ${rule.tell}`);
  if (rule.skill) parts.push("有 Skill");
  if (rule.prompt) parts.push("有 Prompt");
  if (rule.emits) parts.push(`可发 ${rule.emits.source} ${rule.emits.types.join("、")}`);
  return parts.join(" · ");
}

/**
 * What a rules file that passes leaves for its owner to do or to know, where people are concerned and where a rule waits
 * on the clock's own source: nothing here is wrong, but each is easy to leave half done.
 */
export function peopleHints(rules: Rules): string[] {
  const hints: string[] = [];
  const machines = new Set(Object.values(rules.agents).map((agent) => agent.worker));
  for (const [id, person] of Object.entries(rules.people ?? {})) {
    // A name no Agent runs on guards nothing: most likely a slip, and the guard it was meant to be is silently off.
    for (const worker of (person.workers ?? []).filter((worker) => !machines.has(worker))) {
      hints.push(
        `${id}（${person.name}）的 workers 里的 ${worker} 不是任何 Agent 的接单电脑：写错了的话，` +
          "“他名下的电脑那一轮发给他的卡片不能用成员密钥回答”这一条对那台电脑不起作用",
      );
    }
    if (Object.keys(person.at ?? {}).length) continue;
    if (person.workers?.length) {
      hints.push(
        `${id}（${person.name}）写了 workers 却没有通道地址：他名下的电脑上跑的一轮发给他的卡片，成员密钥答不了，` +
          "又没有通道能让他本人回答，只能由你撤回",
      );
    }
    hints.push(
      `${id}（${person.name}）没有通道地址：发给他的卡片只有他用成员密钥才看得到、答得了。` +
        `给他密钥：agent-autoloop key new person ${id}`,
    );
  }
  for (const rule of rules.rules) {
    // The clock's events go only to the rule whose moment it is, and no source's key can send under that name.
    if (eventRule(rule) && rule.when.source === SCHEDULE) {
      hints.push(
        `规则「${rule.name}」的 when.source 是 ${SCHEDULE}：这个来源名留给定时，来源的密钥往里发事件返回 401，` +
          "这条规则只有手动 run、它自己的卡片被回答或复查到期时才会跑。要定时跑写 cron；要接事件，换成自己登记的来源",
      );
    }
    if (!eventRule(rule) || rule.when.source !== PEOPLE) continue;
    const senders = Object.keys(rules.people ?? {}).filter((id) =>
      (rule.when.from ?? ["*"]).some((from) => from === "*" || from === id),
    );
    const unanswerable = senders.filter((id) => !peopleOf(rules, rule).includes(id));
    if (unanswerable.length) {
      hints.push(
        `规则「${rule.name}」接 ${unanswerable.join("、")} 发的消息，但它的 people 没许可这些人：回执不能把答复发回给他们，只能发给你`,
      );
    }
  }
  return hints;
}

/** The rules as this machine would run them, one line per thing an owner asks about. */
export function explainRules(text: string, now = Date.now(), zone = localZone()): string[] {
  const rules = parseRules(text, now, zone);
  const lines = [
    `时区 ${rules.timezone}；先问你：${rules.askFirst.join("、")}；${rules.rules.length} 条规则`,
    `来源：${Object.entries(rules.sources)
      .map(([id, source]) => `${id}（${source.name}）`)
      .join("、")}`,
    `Agent：${Object.entries(rules.agents)
      .map(([id, agent]) => {
        const limit = agent.maxActive ? `，最多同时 ${agent.maxActive} 轮` : "";
        return `${id}（${agent.name}，${agent.worker}，权限 ${agent.access}${limit}）`;
      })
      .join("、")}`,
  ];
  if (Object.keys(rules.channels).length)
    lines.push(
      `通道：${Object.entries(rules.channels)
        .map(([id, channel]) => {
          const answerers = channel.answerers?.length ? `，回答人 ${channel.answerers.join("、")}` : "";
          return `${id}（${channel.name}${answerers}${channel.links ? "，带链接" : ""}）`;
        })
        .join("、")}`,
    );
  if (rules.defaultChannels) lines.push(`没写 channels 的卡片和通知默认只发 ${rules.defaultChannels.join("、")}`);
  lines.push("规则：");
  for (const rule of rules.rules) lines.push(`  ${rule.name}：${details(rule, rules, now)}`);
  for (const task of rules.elsewhere) {
    const answers = task.cwd ? `；问你的，回答后交给 ${rules.agents[task.to].name} 在 ${task.cwd} 接着做` : "";
    lines.push(`  ${task.name}：在别处（${task.where}）${describeCron(task.cron)}${answers}`);
  }
  return lines;
}

/** What a source event would be handed to, by the rules file alone: no hub, no log, no key. */
export function previewEvent(
  text: string,
  source: string,
  event: unknown,
  now = Date.now(),
  zone = localZone(),
): string[] {
  const rules = parseRules(text, now, zone);
  const parsed = parseEvent(event);
  const lines = [`事件：${source} ${parsed.type}${parsed.subject ? ` ${parsed.subject}` : ""}`];
  if (!rules.sources[source]) lines.push(`来源 ${source} 没有登记在 rules.json 的 sources 里`);
  const matched = rules.rules.filter(
    (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, parsed.type),
  );
  if (!matched.length) {
    lines.push("没有规则接这条事件；真发出去会记成「没有规则接的事件」。");
    return lines;
  }
  lines.push("会派给：");
  for (const rule of matched) lines.push(`  ${rule.name} → ${rule.to} · ${rule.cwd}`);
  return lines;
}
