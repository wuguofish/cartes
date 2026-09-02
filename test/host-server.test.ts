import assert from "node:assert/strict";
import test from "node:test";

import { CartesHostClient } from "../src/host-client.js";
import { startCartesHost } from "../src/host-server.js";
import { MultiplayerTableStore, type HumanTableResult, type PublicTableView } from "../src/multiplayer-store.js";

const TWO_SEAT_DECK = ["♠5", "♥6", "♦9", "♣6", "♠4", "♥8", "♦2", "♣3"];

test("HTTP host serves the human UI and shares one authority with Agent clients", async (context) => {
  const store = new MultiplayerTableStore(() => TWO_SEAT_DECK);
  const host = await startCartesHost({ port: 0, store });
  context.after(() => host.close());

  const page = await fetch(host.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cartes 共桌牌局/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  const lottieRuntime = await fetch(`${host.url}/vendor/lottie-light.min.js`);
  assert.equal(lottieRuntime.status, 200);
  assert.match(lottieRuntime.headers.get("content-type") ?? "", /text\/javascript/);
  const roundAnimation = await fetch(`${host.url}/animations/round-complete.json`);
  assert.equal(roundAnimation.status, 200);
  assert.match(roundAnimation.headers.get("content-type") ?? "", /application\/json/);
  const roundAnimationData = await roundAnimation.json() as { nm?: string; slots?: Record<string, unknown> };
  assert.equal(roundAnimationData.nm, "Cartes round complete flourish");
  assert.equal(Boolean(roundAnimationData.slots?.bgColor), true, "the Lottie exposes an editable background color");

  const created = await request<HumanTableResult>(host.url, "/api/tables", {
    method: "POST",
    body: { mode: "blackjack", human_name: "阿童" },
  });
  const other = await request<HumanTableResult>(host.url, "/api/tables", {
    method: "POST",
    body: { mode: "tenhalf", human_name: "隔壁桌" },
  });
  const managed = await fetch(`${host.url}/api/admin/tables`);
  assert.equal(managed.status, 200);
  const managedPayload = await managed.json() as { tables: Array<{ table_id: string; join_code: string }> };
  assert.equal(managedPayload.tables.length, 2);
  assert.equal(JSON.stringify(managedPayload).includes('"deck"'), false);
  const closed = await fetch(`${host.url}/api/admin/tables/${other.table.table_id}`, { method: "DELETE" });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json() as { closed: boolean }).closed, true);
  const closedHuman = await fetch(`${host.url}/api/human/table`, {
    headers: { Authorization: `Bearer ${other.human_token}` },
  });
  assert.equal(closedHuman.status, 401);
  const agent = new CartesHostClient(host.url);
  const joined = await agent.joinAgent(created.table.join_code, "小葵");
  assert.equal(joined.table.players.length, 2);

  const opened = await request<{ table: PublicTableView }>(host.url, "/api/human/start-round", {
    method: "POST",
    token: created.human_token,
    body: { expected_version: joined.table.version, idempotency_key: "human-start-http-01" },
  });
  assert.deepEqual(opened.table.dealer.cards, ["♦9"]);
  assertPrivateStateAbsent(opened, ["♥8", "♦2"]);

  await agent.waitForEvents(joined.agent_token, 0);
  const waiting = agent.waitForEvents(joined.agent_token, 2_000);
  await request(host.url, "/api/human/action", {
    method: "POST",
    token: created.human_token,
    body: { action: "stand", expected_version: opened.table.version, idempotency_key: "human-stand-http-1" },
  });
  const notice = await waiting;
  assert.equal(notice.timed_out, false);
  assert.equal(notice.events.some((event) => event.kind === "player_stood" && event.actor_name === "阿童"), true);
  assert.equal(notice.table.legal_actions.includes("hit"), true, "the waiting Agent becomes active");

  const ticket = await request<{ reconnect_code: string }>(host.url, "/api/human/reconnect-code", {
    method: "POST",
    token: created.human_token,
    body: { seat_id: joined.table.viewer_seat_id },
  });
  const rejoined = await new CartesHostClient(host.url).rejoinAgent(
    created.table.join_code,
    "小葵",
    ticket.reconnect_code,
  );
  assert.equal(rejoined.table.legal_actions.includes("stand"), true);
  await assert.rejects(() => agent.getAgentView(joined.agent_token), /憑證無效/);

  const departure = await new CartesHostClient(host.url).leaveAgent(rejoined.agent_token);
  assert.equal(departure.left, true);
  assert.deepEqual(await new CartesHostClient(host.url).leaveAgent(rejoined.agent_token), departure);
  const afterLeave = await request<{ table: PublicTableView }>(host.url, "/api/human/table", {
    method: "GET",
    token: created.human_token,
  });
  assert.deepEqual(afterLeave.table.players.map((seat) => seat.name), ["阿童"]);
  assert.equal(afterLeave.table.phase, "ended", "leaving the active final Agent settles the remaining human hand");

  const removable = await agent.joinAgent(created.table.join_code, "阿宇");
  const removed = await request<{ table: PublicTableView }>(host.url, "/api/human/remove-agent", {
    method: "POST",
    token: created.human_token,
    body: {
      seat_id: removable.table.viewer_seat_id,
      expected_version: removable.table.version,
      idempotency_key: "human-remove-http-01",
    },
  });
  assert.deepEqual(removed.table.players.map((seat) => seat.name), ["阿童"]);
  await assert.rejects(() => agent.getAgentView(removable.agent_token), /憑證無效/);

  const unauthorized = await fetch(`${host.url}/api/human/table`, { headers: { Authorization: "Bearer wrong" } });
  assert.equal(unauthorized.status, 401);
  assert.equal(JSON.stringify(await unauthorized.json()).includes('"deck"'), false);
});

async function request<T = unknown>(
  baseUrl: string,
  path: string,
  options: { method: "GET" | "POST"; token?: string; body?: Record<string, unknown> },
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload as T;
}

function assertPrivateStateAbsent(value: unknown, forbiddenCards: string[]): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('"deck"'), false);
  for (const card of forbiddenCards) assert.equal(serialized.includes(card), false, `leaked private card ${card}`);
}
