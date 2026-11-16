// `agent-autoloop mcp`: the hub's doors as MCP tools over stdio, using the keys already in this machine's config.json.
// A machine with a member's key and not the owner's is a member's: it gets the member's tools and none of the owner's.
import { answererFor, messageEvent } from "./me.ts";
import { readConfig } from "../host/config.ts";
import { eachLine } from "../host/lines.ts";
import { versionName } from "../host/version.ts";
import { hubClient, type Hub } from "../protocol/client.ts";

const positive = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  ["status", "查看现在的事项和卡片；before 写上一页的 nextBefore，往前翻更早的轮次", { before: positive }, []],
  ["why", "查看一轮的事件、规则和结果", { run: positive }, ["run"]],
  [
    "answer",
    "回答卡片；选项从 0 开始，也可以写自己的答案",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  ["resolve", "将卡片结案，写明已核实的结果", { card: positive, reason: string }, ["card", "reason"]],
  ["stop", "停止一轮", { run: positive }, ["run"]],
  [
    "emit",
    "用本机来源发送事件；相同编号只记一次",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  ["tell", "用本机来源发送通知；相同编号只发一次", { key: string, text: string }, ["key", "text"]],
  [
    "pause",
    "暂停一条规则：到点不跑、来事件不接也不排队；跳过的事件不会自动补，手动恢复时会列出，之后可以 replay",
    { rule: string, reason: string, until: string },
    ["rule"],
  ],
  ["resume", "恢复一条暂停的规则，结果里列出暂停期间跳过的事件（paused.skipped）", { rule: string }, ["rule"]],
  [
    "replay",
    "补跑一条规则从 since 起暂停时跳过的事件，每条只补一次；since 用恢复结果里的 paused.since",
    { rule: string, since: string },
    ["rule", "since"],
  ],
  ["run", "立即运行一条规则一轮", { rule: string, subject: string, reason: string }, ["rule"]],
] as const;

/** What a member's own Agent gets. Each says what it can't do: the Agent reads these, not the protocol. */
const memberSpecs = [
  [
    "me",
    "看发给我（这台电脑的成员）的卡片：cards 是还等我回答的，recentCards 是最近 20 张处理过的。" +
      "不能看别人的卡片、全局状态和日志；带 channelOnly 的卡片这里不能回答，要本人在通道里回答",
    {},
    [],
  ],
  [
    "answer",
    "回答一张发给我的卡片：choice 是选项的序号（从 0 开始），或者用 text 写自己的回答，两样只写一样；通知不用选，写 text 当处理说明。" +
      "不能回答别人的卡片，也不能回答我名下的电脑自己那一轮发的卡片。回答代表成员本人的决定，要先问过他",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  [
    "say",
    "以我的名义向中台说一件事（提问、卡住了、进度、我会什么）：type 是中台规则约定的类型，text 是要说的话，" +
      "subject 是这件事的对象（比如任务编号），同一个 id 只记一次。发的人由密钥决定，不能替别人说；不能直接派活，谁来处理由中台的规则定",
    { type: string, text: string, subject: string, id: string },
    ["type", "text"],
  ],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: ReturnType<typeof readConfig>) {
  const offered =
    config.person && !config.owner
      ? memberSpecs
      : specs.filter(([name]) => (usesSourceKey(name) ? config.source : config.owner));
  return offered.map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: ["status", "why", "me"].includes(name), destructiveHint: name === "stop" },
  }));
}
type Tool = ReturnType<typeof toolsFor>[number];

function validArguments(tool: Tool, args: any) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (!tool.inputSchema.required.every((key) => Object.hasOwn(args, key))) return false;
  const properties = tool.inputSchema.properties as Record<string, any>;
  const fits = ([key, value]: [string, unknown]) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= schema.minimum;
    return typeof value === "string" && value.trim().length > 0;
  };
  if (!Object.entries(args).every(fits)) return false;
  return tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined);
}

function callTool(hub: Hub, name: Tool["name"], args: any) {
  switch (name) {
    case "me":
      return hub.me();
    case "say":
      return hub.say(messageEvent(args.type, args.text, args));
    case "status":
      return hub.state(args.before);
    case "why":
      return hub.why(args.run);
    case "answer": {
      const { card, ...answer } = args;
      return hub.answer(card, answer);
    }
    case "resolve":
      return hub.resolve(args.card, args.reason);
    case "stop":
      return hub.cancel(args.run);
    case "emit":
      return hub.event(args);
    case "tell":
      return hub.tell(args);
    case "pause":
      return hub.pause(args.rule, {
        ...(args.reason !== undefined && { reason: args.reason }),
        ...(args.until !== undefined && { until: args.until }),
      });
    case "resume":
      return hub.resume(args.rule);
    case "replay":
      return hub.replay(args.rule, { since: args.since });
    case "run":
      return hub.run(args.rule, {
        ...(args.subject !== undefined && { subject: args.subject }),
        ...(args.reason !== undefined && { reason: args.reason }),
      });
  }
}

export async function mcp() {
  const config = readConfig();
  const tools = toolsFor(config);
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  const refuse = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });

  async function answerCall(id: unknown, params: any) {
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args)) return refuse(id, -32602, "工具名或参数不正确");
    try {
      // With the owner's key and a member's both here, a card is answered with whichever may answer it.
      const hub =
        tool.name === "answer"
          ? (await answererFor(config, args.card))!
          : hubClient(config.url, usesSourceKey(tool.name) ? config.source!.key : (config.owner ?? config.person!.key));
      const result = await callTool(hub, tool.name, args);
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
    }
  }

  eachLine(process.stdin, (line) => {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      return refuse(null, -32700, "不是 JSON");
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return refuse(request?.id ?? null, -32600, "请求格式不正确");
    }
    const { id, method, params } = request;
    if (id === undefined) return;
    if (method === "initialize") {
      const serverInfo = { name: "agent-autoloop", version: versionName() };
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo } });
    } else if (method === "ping") reply(id, { result: {} });
    else if (method === "tools/list") reply(id, { result: { tools } });
    // Each answers by itself, however long it takes: a client's ping has to get through meanwhile.
    else if (method === "tools/call") void answerCall(id, params);
    else refuse(id, -32601, "没有这个方法");
  });
}
