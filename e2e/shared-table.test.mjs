import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import { chromium } from "playwright-core";

import { CartesHostClient } from "../dist/src/host-client.js";
import { startCartesHost } from "../dist/src/host-server.js";
import { MultiplayerTableStore } from "../dist/src/multiplayer-store.js";
import { StaticTokenAuthenticator } from "../dist/src/remote-auth.js";
import { RemoteMcpGateway } from "../dist/src/remote-mcp.js";
import { EncryptedFileTablePersistence, generateStateKey } from "../dist/src/store-persistence.js";

const THREE_SEAT_DECK = ["♠5", "♥6", "♦7", "♣9", "♦6", "♣5", "♠4", "♥8", "♠2", "♥3"];

test("the real browser UI stays usable when Agents leave or are removed", async (context) => {
  const store = new MultiplayerTableStore(() => THREE_SEAT_DECK);
  const host = await startCartesHost({ port: 0, store });
  const profileDir = await mkdtemp(join(tmpdir(), "cartes-e2e-"));
  let browserContext = await chromium.launchPersistentContext(profileDir, browserLaunchOptions());
  let page = browserContext.pages()[0] ?? await browserContext.newPage();
  context.after(async () => {
    await browserContext.close().catch(() => undefined);
    await host.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  await page.goto(host.url);
  await page.getByLabel("你的名字").fill("阿童");
  await page.getByRole("button", { name: "建立共桌牌局" }).click();
  await page.locator("#tablePanel").waitFor({ state: "visible" });
  const joinCode = (await page.locator("#joinCode").innerText()).trim();

  await browserContext.close();
  browserContext = await chromium.launchPersistentContext(profileDir, browserLaunchOptions());
  page = browserContext.pages()[0] ?? await browserContext.newPage();
  await page.goto(host.url);
  await page.locator("#tablePanel").waitFor({ state: "visible" });
  assert.equal((await page.locator("#joinCode").innerText()).trim(), joinCode, "the human resumes after a browser restart");

  const firstClient = new CartesHostClient(host.url);
  const secondClient = new CartesHostClient(host.url);
  const first = await firstClient.joinAgent(joinCode, "小葵");
  const second = await secondClient.joinAgent(joinCode, "阿宇");
  await waitForSeatCount(page, 3);

  await page.getByRole("button", { name: "開始牌局" }).click();
  await page.getByText("輪到 阿童", { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="暗牌"]').count(), 1, "the unrevealed dealer card stays hidden");
  await page.getByRole("button", { name: "停牌" }).click();
  await page.getByText("輪到 小葵", { exact: true }).waitFor();

  await secondClient.waitForEvents(second.agent_token, 0);
  const departure = await firstClient.leaveAgent(first.agent_token);
  assert.equal(departure.left, true);
  const secondNotice = await secondClient.waitForEvents(second.agent_token, 0);
  assert.equal(secondNotice.events.some((event) => event.kind === "seat_left" && event.actor_name === "小葵"), true);
  assert.equal(secondNotice.table.active_seat_id, second.table.viewer_seat_id);
  await waitForSeatCount(page, 2);
  await page.getByText("輪到 阿宇", { exact: true }).waitFor();

  const ended = await secondClient.agentAction(
    second.agent_token,
    "stand",
    secondNotice.table.version,
    "e2e-agent-stand-after-leave",
  );
  assert.equal(ended.phase, "ended");
  await page.getByText("本局結束，可以再開一局", { exact: true }).waitFor();

  const returned = await firstClient.joinAgent(joinCode, "小葵");
  assert.notEqual(returned.table.viewer_seat_id, departure.seat_id);
  await waitForSeatCount(page, 3);
  const returnedRow = page.locator(".roster-row").filter({ hasText: "小葵" });
  page.once("dialog", (dialog) => dialog.accept());
  await returnedRow.getByRole("button", { name: "移除" }).click();
  await waitForSeatCount(page, 2);
  await assert.rejects(() => firstClient.getAgentView(returned.agent_token), /憑證無效/);
  assert.equal(await page.locator(".roster-row").filter({ hasText: "小葵" }).count(), 0);
});

test("a stale human resume token is cleared after the in-memory Host restarts", async (context) => {
  let host = await startCartesHost({ port: 0 });
  const port = host.port;
  const profileDir = await mkdtemp(join(tmpdir(), "cartes-e2e-stale-"));
  const browserContext = await chromium.launchPersistentContext(profileDir, browserLaunchOptions());
  const page = browserContext.pages()[0] ?? await browserContext.newPage();
  context.after(async () => {
    await browserContext.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true });
  });

  await page.goto(host.url);
  await page.getByRole("button", { name: "建立共桌牌局" }).click();
  await page.locator("#tablePanel").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => Boolean(localStorage.getItem("cartes_human_token"))), true);

  await host.close();
  host = await startCartesHost({ port });
  await page.reload();
  await page.locator("#setupPanel").waitFor({ state: "visible" });
  await page.getByText("原本的牌桌已不存在，請重新開桌。", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("cartes_human_token")), null);
});

test("the remote human resumes after both the browser and encrypted Host restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cartes-e2e-remote-"));
  const profileDir = join(directory, "chrome-profile");
  const statePath = join(directory, "state.enc.json");
  const stateKey = generateStateKey();
  const humanAccessKey = "human-e2e-remote-access-key-000000000001";
  const port = await availablePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const authenticator = new StaticTokenAuthenticator({ e2e: "agent-e2e-remote-token-0000000000000001" });

  let remote = await startRemoteHost({ port, publicUrl, statePath, stateKey, humanAccessKey, authenticator });
  let browserContext = await chromium.launchPersistentContext(profileDir, browserLaunchOptions());
  let page = browserContext.pages()[0] ?? await browserContext.newPage();
  context.after(async () => {
    await browserContext.close().catch(() => undefined);
    await remote.gateway.close().catch(() => undefined);
    await remote.host.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  await page.goto(publicUrl);
  await page.getByLabel("遠端建桌密碼").waitFor({ state: "visible" });
  await page.getByLabel("遠端建桌密碼").fill(humanAccessKey);
  await page.getByRole("button", { name: "建立共桌牌局" }).click();
  await page.locator("#tablePanel").waitFor({ state: "visible" });
  const joinCode = (await page.locator("#joinCode").innerText()).trim();

  await browserContext.close();
  await remote.gateway.close();
  await remote.host.close();
  remote = await startRemoteHost({ port, publicUrl, statePath, stateKey, humanAccessKey, authenticator });
  browserContext = await chromium.launchPersistentContext(profileDir, browserLaunchOptions());
  page = browserContext.pages()[0] ?? await browserContext.newPage();
  await page.goto(publicUrl);
  await page.locator("#tablePanel").waitFor({ state: "visible" });
  assert.equal((await page.locator("#joinCode").innerText()).trim(), joinCode);
  assert.equal(await page.evaluate(() => Boolean(localStorage.getItem("cartes_human_token"))), true);
});

function browserLaunchOptions() {
  const executablePath = process.env.CARTES_BROWSER_EXECUTABLE;
  if (executablePath) return { executablePath, headless: true };
  return { channel: process.env.CARTES_BROWSER_CHANNEL || "chrome", headless: true };
}

async function waitForSeatCount(page, expected) {
  await page.waitForFunction(
    (count) => document.querySelector("#seatCount")?.textContent === String(count),
    expected,
  );
}

async function startRemoteHost({ port, publicUrl, statePath, stateKey, humanAccessKey, authenticator }) {
  const store = new MultiplayerTableStore(undefined, {
    persistence: new EncryptedFileTablePersistence(statePath, stateKey),
  });
  const gateway = new RemoteMcpGateway({ store, authenticator, publicUrl, humanAccessKey });
  const host = await startCartesHost({ hostname: "127.0.0.1", port, store, extension: gateway });
  return { gateway, host };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port.");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
