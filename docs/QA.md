# MCP 共桌版驗證報告

驗證日期：2026-09-02
驗證範圍：`feat/multi-table-admin` 本機 STDIO、Streamable HTTP Remote MCP、加密持久化、多桌營運台、人類 UI 與多 Agent 共桌

## 結論

目前自動化驗證為 **PASS**：MCP game core 與原版瀏覽器規則在固定牌序下逐步一致；一位人類與多個獨立 Agent 能依序完成同一局；每個 Agent 的通知游標互相獨立；已測的本機與 Remote UI／MCP 成功、錯誤、版本衝突及冪等重試路徑都沒有回傳未翻開的莊家底牌或剩餘牌堆。

Remote 測試涵蓋目前實作的傳輸、身分與資料邊界，但不是第三方滲透測試或外部 OIDC provider 的相容性認證；TLS、reverse proxy、主機權限與 Authorization Server 仍須由實際部署者驗證。

## 自動化證據

執行：

```powershell
npm test
npm run test:e2e
npm run typecheck
npm audit --audit-level=high
git diff --check
docker build -t cartes-remote:test .
```

結果：

- 27 個 Node 測試全部通過；
- 4 個真實無頭 Chrome E2E 測試通過；
- TypeScript typecheck 通過；
- npm audit：0 vulnerabilities；
- `git diff --check` 通過；
- Docker image build 通過，實際容器 smoke test 亦通過。

## Docker Remote MCP smoke test

以 `cartes-remote:test` 啟動隔離的暫時容器，映射至 localhost 測試連接埠，使用靜態 Bearer principal、Remote 人類建桌密碼與暫時的加密狀態檔。驗證結果：

- image 能完整執行 multi-stage build，production dependencies 的 npm audit 為 0 vulnerabilities；
- runtime 以 `node` 非 root 使用者執行，Docker healthcheck 回報 `healthy`；
- `/api/remote-health` 回報 `streamable-http`、`bearer` 與 `encrypted-file`；
- 未帶人類建桌密碼的 `POST /api/tables` 回 `401`，帶正確密碼則回 `201` 並建立牌桌；
- 未帶 Bearer token 的 `POST /mcp` 回 `401`；
- 落地狀態只有 AES-256-GCM envelope 欄位（`algorithm`、`iv`、`tag`、`ciphertext`），沒有明文牌桌狀態；
- server log 未輸出測試用 Bearer token、人類建桌密碼或狀態加密金鑰。

測試容器已在驗證後停止並由 `--rm` 自動刪除；本機僅保留 `cartes-remote:test` image 供後續重測。

## 多桌與 Compose 開關測試

多桌 store／HTTP／Remote 測試同時建立兩張不同模式的牌桌，確認管理列表不含 `deck` 或手牌、關閉 A 桌會撤銷該桌人類與 Agent token、喚醒 pending long poll 並釋放 Remote principal，而 B 桌可繼續操作。未帶營運管理密碼的 Remote 管理 API 回 `401`。

第三條真實 Chrome E2E 在同一瀏覽器設定檔連續建立兩桌，確認兩組人類 capability 依 table ID 保存、營運台同時顯示兩桌、A 桌能另開分頁且仍是原座位。從營運台關閉 A 桌後，A 桌分頁收到憑證失效並回到營運台，B 桌仍保留。

另以 `compose.remote.yml` 與 PowerShell 開關跑實際 Docker lifecycle：容器以 read-only root filesystem、`cap_drop: ALL`、`no-new-privileges`、512 MB 上限與 host loopback port 啟動並通過 healthcheck；建立一桌後執行停止腳本，確認容器與 network 移除而 volume 保留。再次以 `-NoBuild` 啟動後，原人類 token、table ID 與邀請碼均恢復；最終停止並清除隔離測試 volume。

## 規則對拍

`test/browser-parity.test.ts` 會用 jsdom 執行原版 `index.html` 的 `window.cardsTest`，再把同一副固定牌序與同一串動作送入 MCP game core。每次發牌與每次行動後都比對：

- 玩家手牌、莊家完整手牌與規則允許的可見手牌；
- 剩餘牌序；
- 回合狀態、底牌是否翻開；
- 勝負與特殊牌型。

目前共有 24 組代表局面，涵蓋 21 點與十點半的 Blackjack、soft 17、A 降點、爆牌、平手、十點半、五龍、花牌半點，以及莊家多次補牌。

原版的完整底牌與牌堆只從瀏覽器既有的測試鉤子讀取，僅用於同 process 的測試比對；MCP schema 與 tool result 不提供這個鉤子。

## 共桌、通知與雙盲紅隊測試

`test/multiplayer-store.test.ts` 驗證一位人類與兩個 Agent 的座位順序、各自合法動作、莊家結算與戰績，並覆蓋：

- 同一事件會出現在每個 Agent 各自的未讀佇列；
- Agent A 讀取事件不會吃掉 Agent B 的通知；
- 人類動作會喚醒兩個正在等待的 Agent；
- Agent A 說話會喚醒 Agent B；
- 聊天不改變遊戲版本；
- 相同 idempotency key 不會重複執行動作。
- 人類產生的一次性重連碼能在進行中的回合接回同一座位，錯誤名稱、重複使用及舊 token 都會被拒絕。
- process 只持有失效 token 時，`join_table` 會自動清除舊狀態並加入新桌；有效 token 仍禁止同 process 取得第二個座位。
- Agent 在自己的回合永久離桌後，token 與重連碼會失效、同一離桌可安全重試，並自動把回合交給下一席。
- 人類可以移除 Agent 座位；舊 token 立即失效，同名 Agent 之後只能取得全新座位。

`test/host-server.test.ts` 透過真實 HTTP listener 驗證 UI 靜態資源、安全標頭、人類建桌、Agent 入座、Bearer 席位憑證與人類動作喚醒 Agent。

`test/mcp-server.test.ts` 啟動兩個獨立的 in-memory MCP client/server 連線，共用同一個 HTTP Host。在固定牌序放入可辨識暗牌 canary，檢查完整 tool result（文字與 structured content）：

| 路徑 | 驗證 |
| --- | --- |
| `join_table` | 取得獨立座位，但 capability token 不進入 MCP result |
| `get_table_view` | 重讀不增加可見資訊 |
| `say_at_table` | Agent A 的話喚醒 Agent B，不洩漏私有狀態 |
| `take_action` | 非目前玩家被拒；輪替、停牌與結算使用最新版本 |
| `wait_for_table_event` | 讀到人類／其他 Agent 的動作，並取得自己的最新合法動作 |
| 暗牌 canary | 莊家底牌、下一張牌與 `deck` 欄位在攤牌前均不可見 |

另由 `test/stdio.test.ts` 啟動兩個真正獨立的編譯後 STDIO server process，確認它們能加入同一張人類牌桌，並透過共用 Host 看到彼此的加入事件；每個 process 仍只持有自己的 Agent 座位憑證。

## Remote MCP 與持久化安全測試

`test/remote-mcp.test.ts` 透過官方 MCP SDK 的 `StreamableHTTPClientTransport` 連接真實 HTTP listener，驗證：

- 未帶 Bearer token 的每個 MCP request 都回 `401` 與 `WWW-Authenticate`；
- 非 allowlist 的 `Origin` 在進入 MCP transport 前被拒絕；
- 另一個 Bearer principal 即使取得 MCP session ID，也無法重用該 session；
- 不同 token 取得不同 Agent 座位，同一 token 建立新 MCP session 時只會接回原座位；
- 新 session 接管後舊座位 capability 失效，不會留下兩個同身分控制者；
- 未授權訪客不能建立人類牌桌；
- Streamable HTTP tool result 仍沒有 `deck` 或莊家暗牌 canary。

`test/store-persistence.test.ts` 讓牌局進入 Agent 回合後關閉原 store，再以同一加密檔與金鑰建立新 store。原人類 token 能恢復同一牌桌，原 remote principal 能接回相同 seat ID、手牌與合法動作；舊 Agent token 被撤銷。直接檢查落地 JSON envelope 時，看不到人類／Agent token、玩家名稱或暗牌明文；錯誤 `CARTES_STATE_KEY` 會 fail closed，不能載入狀態。

## 真實 Codex 與 UI 端到端

以本機 `codex exec` 連接實際 MCP 設定，從人類瀏覽器 UI 完成一局 21 點：

1. 人類建立共桌，Codex 以邀請碼入座並在桌邊聊天；
2. 人類從 UI 開局，Codex 的等待呼叫收到 `round_started` 與人類回合；
3. 人類要牌時，Codex 收到 `player_hit`，但沒有得到不屬於自己的合法動作；
4. 人類停牌時，Codex 收到 `player_stood` 與自己的 `turn_started`；
5. Codex 依 17 點手牌及莊家 10 點明牌自行選擇停牌；
6. Host 才公開莊家底牌並結算莊家 20 點勝出。

桌面版及 390 × 844 手機 viewport 均人工檢查過建桌、邀請碼、座位、牌面、暗牌、聊天、按鈕禁用與結算狀態；沒有發現遮擋或橫向溢出。

另以 Codex「小葵」與 Claude Code「阿宇」同時加入人類牌桌，完成一局十點半：兩個不同 MCP client 都收到人類及彼此的回合事件，依序停牌後由 Host 結算，確認跨 client 的三席實際共桌成立。

## 真實瀏覽器 E2E

`npm run test:e2e` 會啟動隔離的臨時 Host 與無頭 Chrome，從真正的 UI 建桌，再關閉整個瀏覽器 context 並用同一個持久化設定檔重開，確認人類自動回到相同邀請碼的牌桌。接著由兩個 Host client 入座，確認莊家底牌仍以暗牌呈現、人類停牌後輪到第一個 Agent、該 Agent 永久離桌時 UI 座位數降為二且回合自動交給下一席；牌局結束後，同名 Agent 只能以新座位回來。最後由人類 UI 按「移除」，確認確認對話、座位清除與舊 token 撤銷都生效。

第二條瀏覽器 E2E 會在 UI 已保存人類 token 後重啟同一連接埠的 Host。因記憶體牌桌已不存在，頁面重新整理後必須回到建桌畫面、顯示原桌已不存在，並從 `localStorage` 清除失效 token。

第四條瀏覽器 E2E 使用 Remote 模式的營運管理密碼與加密狀態檔，先由真正 Chrome UI 建桌，再同時關閉整個瀏覽器與 Remote Host。以同一公開來源、瀏覽器 profile、狀態檔與金鑰重啟後，人類必須自動回到相同邀請碼的牌桌，證明 Remote 人類續桌不只停留在 store 單元測試。

## 第二局續接測試

以 Codex 與 Claude Code 完成第一局後，人類直接開始第二局。第一個 Codex 任務在第一局結束時已退出，因此舊 Agent 座位仍在、STDIO process 與私有 token 卻已消失，第二局輪到該座位時無法繼續。這個案例確認不能用公開名稱自動認領舊座位，也證明多局玩法需要明確的 reconnect lifecycle。

修正後先以隔離 Host 驗證：人類 UI 能替指定 Agent 產生 10 分鐘一次性重連邀請；store 與真實 HTTP 測試確認新 process 接回原手牌及合法動作、舊 token 失效、重連碼不可重放，且重連碼不進入公開 table view。

接著在真實三人十點半牌桌完成重連回歸：人類從 UI 分別替 Codex「小葵」與 Claude Code「阿宇」產生一次性重連邀請，兩個 client 都在舊 process 結束、新 MCP process 啟動後接回原座位。重連前後座位 ID、手牌與戰績一致，牌桌仍維持三席，沒有產生重複 Agent；重連成功後兩個 Agent 均能繼續等待事件並完成第三局。另以第三個獨立 MCP process 重放小葵已使用的重連碼，Host 正確拒絕為「重連碼無效或已過期」。

## 洗牌檢查

正式牌局使用 `crypto.randomInt` 驅動 Fisher–Yates shuffle。測試連續建立 100 副洗牌結果，逐副確認仍是 52 張、無重複、無缺牌。

固定牌序注入只存在 game core、測試用 store 與測試 Host；正式 MCP tools 和人類 API 沒有接受 deck／seed／card 的輸入欄位。這項檢查能證明牌組完整性與介面封鎖，不能單獨當作隨機分布的統計認證。

## 尚待下一階段

- 以實際公開 HTTPS staging、Codex OAuth 與 Claude Code OAuth 各跑一次外部 OIDC provider 相容性測試；
- 若要水平擴充多副本，將單檔持久化替換成具交易與 row lock 的資料庫；
- 增加跨裝置的人類帳號登入與座位找回；
- 若加入真人多人或觀戰者，為每種角色新增獨立視角與權限測試。
