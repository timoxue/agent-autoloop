// Failure modes: a source revokes somebody else's key; a revoked key keeps a pending poll or stream alive; CLI writes
// a different database instead of revoking through the running hub; a key named the way `key new` allows cannot be
// revoked; removing a key that was never there is reported as if the key was revoked; a key replaced from the command
// line, which writes the database itself and wakes nobody in the running hub, goes on being served by a poll that was
// already waiting on it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
setup("key-remove");
const hub = await import("./hub.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler();
after(runtime.close);
const owner = hub.addKey("owner", "me");
const worker = hub.addKey("worker", "w1");
const source = hub.addKey("source", "app");
const request = (path: string, key: string, method = "GET") =>
  runtime.handle(
    new Request("http://local" + path, {
      method,
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    }),
  );
test("a name `key new` allows can be revoked, and removal says whether it was there", async () => {
  const name = "MacBook_prod.2";
  const key = hub.addKey("source", name);
  const path = `/v1/keys/source/${encodeURIComponent(name)}`;
  assert.equal((await request(path, source, "DELETE")).status, 401);
  assert.deepEqual(await (await request(path, owner, "DELETE")).json(), { ok: true, changed: true });
  assert.equal((await request("/v1/events", key, "POST")).status, 401);
  assert.deepEqual(await (await request(path, owner, "DELETE")).json(), { ok: true, changed: false });
  assert.equal(hub.removeKey("source", "never-there"), false);
  assert.equal((await request("/v1/keys/source/%zz", owner, "DELETE")).status, 400);
  const long = "a".repeat(201);
  const longKey = hub.addKey("source", long);
  assert.deepEqual(await (await request(`/v1/keys/source/${long}`, owner, "DELETE")).json(), {
    ok: true,
    changed: true,
  });
  assert.equal((await request("/v1/events", longKey, "POST")).status, 401);
});

test("only the owner removes keys and pending work is refused immediately", async () => {
  assert.equal((await request("/v1/keys/worker/w1", source, "DELETE")).status, 401);
  const waiting = request("/v1/work?claim=pending&wait=50", worker);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request("/v1/keys/worker/w1", owner, "DELETE")).status, 200);
  assert.equal((await waiting).status, 401);
  assert.equal((await request("/v1/work?claim=next&wait=0", worker)).status, 401);
  const response = await request(`/v1/stream?after=${hub.getView().seq}`, owner);
  const reader = response.body!.getReader();
  assert.equal((await request("/v1/keys/owner/me", owner, "DELETE")).status, 200);
  assert.equal((await reader.read()).done, true);
});

test("a key replaced from the command line is refused by the poll already waiting on it, at the latest when its wait ends", async () => {
  const old = hub.addKey("worker", "w2");
  const ends = new AbortController();
  const headers = { authorization: `Bearer ${old}` };
  const waiting = runtime.handle(
    new Request("http://local/v1/work?claim=replaced&wait=50&capacity=0", { headers, signal: ends.signal }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  // Another process: it writes the new key to the database itself, and nothing tells the hub's waiting polls.
  const cli = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
  const args = ["--disable-warning=ExperimentalWarning", cli, "key", "new", "worker", "w2"];
  const { stdout } = await promisify(execFile)(process.execPath, args, { env: process.env });
  ends.abort();
  assert.equal((await waiting).status, 401);
  assert.equal((await request("/v1/work?claim=fresh&wait=0&capacity=0", stdout.trim())).status, 200);
});
