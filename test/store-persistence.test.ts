import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MultiplayerTableStore } from "../src/multiplayer-store.js";
import { EncryptedFileTablePersistence, generateStateKey } from "../src/store-persistence.js";

const DECK = ["♠5", "♥6", "♦9", "♣6", "♠4", "♥8", "♦2", "♣3"];

test("encrypted persistence restores the human and principal-bound Agent seats without leaking tokens or cards", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cartes-persistence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "tables.enc.json");
  const stateKey = generateStateKey();
  const persistence = new EncryptedFileTablePersistence(path, stateKey);
  const store = new MultiplayerTableStore(() => DECK, { persistence });

  const created = store.createTable("blackjack", "阿童");
  const joined = store.joinAgentForPrincipal(created.table.join_code, "小葵", "static:xiaokui");
  const opened = store.startRound(created.human_token, joined.table.version, "persist-start-0001");
  store.humanAction(created.human_token, "stand", opened.version, "persist-human-stand-1");

  const ciphertext = await readFile(path, "utf8");
  assert.doesNotMatch(ciphertext, new RegExp(created.human_token));
  assert.doesNotMatch(ciphertext, new RegExp(joined.agent_token));
  assert.equal(ciphertext.includes("♥8"), false, "hidden cards must not appear in the encrypted envelope");
  assert.equal(ciphertext.includes("小葵"), false, "player names must not appear in the encrypted envelope");

  const restored = new MultiplayerTableStore(() => DECK, {
    persistence: new EncryptedFileTablePersistence(path, stateKey),
  });
  const humanView = restored.getHumanView(created.human_token);
  assert.equal(humanView.table_id, created.table.table_id);
  assert.equal(humanView.active_seat_id, joined.table.viewer_seat_id);

  const resumed = restored.joinAgentForPrincipal(created.table.join_code, "小葵", "static:xiaokui");
  assert.equal(resumed.table.viewer_seat_id, joined.table.viewer_seat_id);
  assert.equal(resumed.table.legal_actions.includes("stand"), true);
  assert.throws(() => restored.getAgentView(joined.agent_token), /憑證無效/);
  assert.throws(
    () => restored.joinAgentForPrincipal(created.table.join_code, "冒牌小葵", "static:xiaokui"),
    /名稱不符/,
  );
});

test("an encrypted state file rejects the wrong key", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cartes-wrong-key-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "tables.enc.json");
  const persistence = new EncryptedFileTablePersistence(path, generateStateKey());
  new MultiplayerTableStore(undefined, { persistence }).createTable("tenhalf", "阿童");

  assert.throws(
    () => new MultiplayerTableStore(undefined, { persistence: new EncryptedFileTablePersistence(path, generateStateKey()) }),
    /無法解密/,
  );
});
