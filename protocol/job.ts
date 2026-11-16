import type { Rule } from "../kernel/rules.ts";
export type Job = {
  run: number;
  token: string;
  attempt: number;
  /** people: whom its receipts may address a card to; only there when the rule allows any. */
  rule: Pick<Rule, "name" | "cwd" | "skill" | "prompt" | "title" | "emits"> & {
    people?: { id: string; name: string }[];
  };
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    tier?: string;
    access: string;
    command?: string[];
    program?: string;
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  context: {
    /** The rule again, for an Agent that reads only this file: its name, whom it may name, what it may send. */
    rule?: { name: string; people?: { id: string; name: string }[]; emits?: Rule["emits"] };
    /** The matter this round is of: the subject under `parallel`, otherwise empty. */
    lane?: string;
    /** When the hub handed this execution out, by its own clock. */
    claimedAt?: string;
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
      /** The member who sent it, on a message that came with a member's key. */
      from?: { id: string; name: string };
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      chosen: string | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
    }[];
    timers: { key: string; about: string; at: string }[];
    waiting: { key: string; about: string; at: string }[];
    /** to: whom the card is for, when not the owner. rule, lane: the matter it belongs to. key: the one its receipt gave. */
    open: {
      card: number;
      title: string;
      text: string;
      at: string;
      to?: { id: string; name: string };
      rule?: string;
      lane?: string;
      key?: string;
    }[];
    decided: { card: number; title: string; choice: string | null; at: string; key?: string }[];
  };
};
