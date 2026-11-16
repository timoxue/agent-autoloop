// A member's side: what `agent-autoloop me` shows, and how a member's words become the event `say` sends. The command
// line and MCP both use these, so the two say and send the same.
import { randomUUID } from "node:crypto";
import type { Config } from "../host/config.ts";
import { hubClient } from "../protocol/client.ts";
import { clockFor } from "./status.ts";

type Card = {
  id: number;
  kind: string;
  state: string;
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  rule: string | null;
  createdAt: string;
  channelOnly?: boolean;
};
export type Mine = { me: { id: string; name: string }; cards: Card[]; recentCards: Card[]; now: string };

const INDENT = "       ";
const LOOK: Record<string, string> = { decided: "已回答", done: "已完成", closed: "已关闭" };

/** What waits for a member, each card whole with how to answer it, then the last few that are settled. */
export function renderMine({ me, cards, recentCards, now }: Mine) {
  const { when } = clockFor({ now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const out = [`你是 ${me.name}（${me.id}）。等你 ${cards.length}`];
  for (const card of cards) {
    out.push("", `  ${card.kind === "ask" ? "决定" : "留意"} #${card.id} ${card.title}`);
    out.push(`${INDENT}${card.rule ? `来源：${card.rule} · ` : ""}${when(card.createdAt)}`);
    for (const line of card.text.split("\n").filter((line) => line.trim())) out.push(INDENT + line);
    if (card.kind === "ask") {
      card.options.forEach((option, index) => {
        out.push(`${INDENT}${index + 1}. ${option}${index === card.recommend ? "（推荐）" : ""}`);
      });
    }
    // A round on their own machine asked: only they, where the channel shows it to them, can answer.
    if (card.channelOnly) out.push(`${INDENT}这张是你名下的电脑上跑的一轮发的，这里答不了：在通道里收到它的地方回答`);
    else if (card.kind === "ask") out.push(`${INDENT}回答：agent-autoloop answer ${card.id} <序号>`);
    else out.push(`${INDENT}处理完了：agent-autoloop answer ${card.id}`);
  }
  const recent = recentCards.slice(0, 5);
  if (recent.length) out.push("", "最近的卡片");
  for (const card of recent) {
    const chose = card.choice === null ? (card.answer ?? "") : `你选了 ${card.options[card.choice]}`;
    const came = card.result && card.result !== "已处理" ? card.result : "";
    const tail = [chose, came].filter(Boolean).join(" → ");
    const label = card.kind === "notice" && card.state === "closed" ? "已处理" : (LOOK[card.state] ?? card.state);
    out.push(`  #${card.id} ${label} ${card.title}${tail ? `：${tail.replace(/\s*\n\s*/g, " ")}` : ""}`);
  }
  return out.join("\n");
}

/** A member's words as the event they send: all of it in the detail, its start as the one line others list it by. */
export function messageEvent(type: string, words: string, { subject, id }: { subject?: string; id?: string } = {}) {
  const summary = [...words.replace(/\s+/g, " ").trim()].slice(0, 200).join("");
  return { id: id ?? randomUUID(), type, ...(subject && { subject }), summary, detail: words };
}

/**
 * The key that may answer a card from this machine. A member's key answers only what's for them and the owner's only
 * what isn't, so with both here the member's list says which it is.
 */
export async function answererFor(config: Config, card: number) {
  const member = config.person && hubClient(config.url, config.person.key);
  if (!config.owner) return member;
  const owner = hubClient(config.url, config.owner);
  if (!member) return owner;
  const mine: Mine = await member.me();
  return mine.cards.some((open) => open.id === card) ? member : owner;
}
