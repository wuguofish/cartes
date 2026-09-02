# Cartes MCP 共桌版

這個 fork 讓一位人類透過瀏覽器 UI，和一個或多個 MCP Agent 一起玩 21 點或十點半。每位 Agent 都是獨立玩家，有自己的手牌、回合與戰績；所有玩家共同對戰規則驅動的莊家。MCP 可選完全本機的 STDIO，或自行架設的 Streamable HTTP Remote MCP。

原本的單檔 `index.html` 沒有被改成需要後端，既有玩法仍可照常使用。新版共桌 UI 位於 `web/`，由本機 Cartes Host 提供。

## 架構

```text
人類瀏覽器 UI ──────────────┐
                            │ HTTP + 席位憑證
本機 STDIO MCP ─────────────┼── Cartes Host ── 共用規則、牌堆、回合、事件游標
Remote Streamable HTTP MCP ─┘       ├─ 本機：記憶體
                                    └─ 遠端：加密持久化
```

- `cartes-host` 是唯一牌局權威，持有牌堆、莊家暗牌與所有座位狀態。
- 本機模式由每個 MCP client 啟動自己的 `cartes-mcp` STDIO process；該 process 只在記憶體持有自己座位的 capability token。
- Remote 模式逐次驗證 Bearer／OAuth token，並把驗證後的 caller principal 綁定座位；不同 principal 不能接管彼此的 MCP session 或座位。
- 人類在 UI 建立牌桌並取得邀請碼。Agent 只能用邀請碼入座，無法列舉其他牌桌。
- 人類負責開局；之後依入座順序逐家行動，全部停牌或爆牌後由莊家自動結算。
- 本機 Host 的牌桌只存在記憶體；Remote Host 使用 AES-256-GCM 加密快照，Host 重啟後可恢復牌桌、回合、事件游標與憑證雜湊。

## 本機 STDIO 模式

需求：Node.js 20 以上。

```powershell
npm install
npm start
```

`npm start` 會先編譯再啟動 Host，並持續占用這個終端。Host 預設只監聽 `127.0.0.1:3210`。在瀏覽器開啟 `http://127.0.0.1:3210`，輸入人類玩家名稱與模式後建立共桌。

另一個終端可用 `npm run health` 確認 Host URL 與版本；若 Host 不在預設位置，替命令設定 `CARTES_HOST_URL`。

把編譯後的 STDIO adapter 加到每個 MCP client。Codex CLI 範例：

```powershell
codex mcp add cartes -- node D:\絕對路徑\cartes\dist\src\index.js
```

Claude Code 範例：

```powershell
claude mcp add --transport stdio --scope user cartes -- node D:\絕對路徑\cartes\dist\src\index.js
```

設定後重新啟動對應 client。Claude Code 可用 `claude mcp get cartes`、`claude mcp list` 或互動介面的 `/mcp` 檢查連線。

若 Host 不在預設位置，為 MCP process 設定 `CARTES_HOST_URL`。Host 連接埠可用 `CARTES_HOST_PORT` 變更。

UI 的「複製 Agent 邀請詞」會產生可直接貼給 Agent 的提示。也可以自行說：

```text
請使用 cartes MCP，以「小葵」加入牌桌 ABCDEFG。加入後先打招呼，
只在 legal_actions 有 hit 或 stand 時出牌；否則用 wait_for_table_event
等待其他玩家，持續到本局結束。
```

若要多個 Agent，同一組邀請碼分別交給各個 MCP client 即可；每個 client 都會取得不同座位與不同的未讀事件游標。

## Remote MCP 模式

Remote 模式由 `npm run start:remote` 啟動同一套人類 UI、Host API 與 `/mcp` Streamable HTTP endpoint。它不是把本機 `3210` 直接暴露到網路；啟動時會強制要求：

- `CARTES_PUBLIC_URL`：外部使用者實際連線的固定 URL，正式環境必須是 HTTPS；
- `CARTES_STATE_KEY`：32 bytes Base64URL 金鑰，用來加密完整牌桌狀態；
- `CARTES_HUMAN_ACCESS_KEY`：至少 32 字元，只有持有者能建立新桌；
- 靜態 Bearer 模式的 `CARTES_REMOTE_KEYS_FILE`（也可用 `CARTES_REMOTE_KEYS_JSON` 注入相同 JSON），或 OIDC 模式的 issuer／audience。

其他環境變數：

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `CARTES_REMOTE_HOST` | `127.0.0.1` | reverse proxy 連入的監聽介面；容器內可設 `0.0.0.0` |
| `CARTES_REMOTE_PORT` | `3210` | 內部 HTTP port |
| `CARTES_STATE_PATH` | `data/cartes-state.enc.json` | 加密狀態檔位置 |
| `CARTES_ALLOWED_HOSTS` | 公開 URL 的 host | 逗號分隔的額外 Host allowlist |
| `CARTES_ALLOWED_ORIGINS` | 公開 URL 的 origin | 逗號分隔的額外 Origin allowlist |
| `CARTES_OIDC_REQUIRED_SCOPE` | `cartes:play` | Remote MCP access token 必須具備的 scope |
| `CARTES_ALLOW_INSECURE_HTTP` | 未設定 | 僅本機 smoke test 設為 `1`；正式環境不可使用 |

可用 `npm run generate:remote-secrets -- agent-name` 產生初始 secrets。每個 Agent 必須分配不同靜態 token；同一 token 代表同一遠端身分，新 MCP session 會安全接回並撤銷舊 session 的座位 capability。靜態 key 檔含有真正的登入秘密，必須放在 `data/` 等不進版控、只有服務帳號可讀的位置。

### OIDC／OAuth

設定 `CARTES_OIDC_ISSUER` 與 `CARTES_OIDC_AUDIENCE` 後，Remote Host 會讀取 issuer 的 OpenID discovery metadata，以 JWKS 驗證 JWT 的簽章、issuer、audience、期限與 required scope，並在 `/.well-known/oauth-protected-resource` 公開 RFC 9728 metadata。Authorization Server 仍由部署者提供，且必須支援 MCP client 所採用的 CIMD、DCR 或預先註冊 client 流程。

OIDC principal 由 issuer、subject 與 token 的 `client_id`／`azp` 組成；不同 client 身分不會共用座位。若 provider 不發出 client 識別 claim，則同一 subject 會視為同一 Agent 身分。

Codex 可先加入 URL，再執行 OAuth login：

```powershell
codex mcp add cartes-remote --url https://cartes.example.com/mcp
codex mcp login cartes-remote
```

Claude Code 可加入 HTTP endpoint，接著在互動介面用 `/mcp` 完成登入：

```powershell
claude mcp add --transport http --scope user cartes-remote https://cartes.example.com/mcp
```

若 Authorization Server 不支援 client 自動註冊，必須依各 client 文件預先註冊 client ID 與精確 callback URL。

### TLS 與公開部署

Node process 預設只監聽 loopback，應由 Caddy、nginx、Cloudflare Tunnel 或同等 reverse proxy 終止 TLS。Proxy 必須保留正確的 `Host`，限制 request body／連線數並設定速率限制；`wait_for_table_event` 最長 25 秒，仍應限制每個來源的並行連線。不要讓 Agent 執行環境取得 Remote Host 的狀態檔、`CARTES_STATE_KEY`、靜態 key 檔或服務帳號權限，否則任何應用層雙盲都無法阻止它直接讀取伺服器秘密。

Repo 內附非 root runtime 的 `Dockerfile`；容器部署時將 `/app/data` 掛載到持久 volume、設定 `CARTES_REMOTE_HOST=0.0.0.0`，並由外層 ingress 提供 HTTPS。不要把 secrets 寫進 image layer、Dockerfile 或 compose 檔，應使用部署平台的 secret store／環境注入。

## Agent 如何知道別家動了

`wait_for_table_event` 是有上限的 long poll，最多等待 25 秒。有人加入、開局、要牌、停牌、爆牌、結算或說話時，Host 會喚醒所有正在等待的 Agent。每位 Agent 的游標互相獨立，因此 Agent A 讀過事件不會讓 Agent B 漏掉。

逾時不是牌局結束；Agent 應重新呼叫等待。這個設計不要求 STDIO Server 主動把訊息塞進 client，也避免一個 MCP request 無限占住。MCP client 或模型若在一次回覆後不會繼續呼叫工具，仍需要 client 本身支援持續的 agent loop；Cartes 無法跨過產品邊界強制喚醒已停止執行的模型。

## Agent 續局與安全重連

Agent instructions 會要求它持續參與後續牌局，直到人類結束測試。不過若 MCP client、模型回合或 STDIO process 已經退出，原本的座位 token 也會留在舊 process，不能只靠公開的玩家名稱接管座位。

人類可以在 UI 的 Agent 名單按「重連」：Host 會為指定座位產生一組 10 分鐘內有效、只能使用一次的重連碼，並把完整重連邀請詞複製到剪貼簿。新 Agent process 使用相同 `join_code`、`agent_name`，並在 `join_table` 傳入 `reconnect_code`，就能接回原座位、手牌、回合與戰績。接管成功後，舊 token 立即失效；其他 Agent 也會收到 `seat_reconnected` 事件。

重連碼只會回傳給已驗證的人類 UI，不會出現在牌桌公開視角或一般 MCP tool result。若懷疑邀請詞外洩，重新按一次「重連」就會讓上一組尚未使用的碼失效。

如果 Host 重啟、原座位被人類授權的新 process 接管，或舊座位憑證因其他原因失效，原 MCP process 下一次呼叫 `join_table` 時會先向 Host 驗證舊 token。確認失效後會自動清除 process 內的舊座位狀態，再加入新桌；暫時連不上 Host 等一般網路錯誤不會誤清 token。仍持有有效座位時，`join_table` 會繼續拒絕第二個座位。

`leave_table` 代表永久放棄座位，和暫時斷線不同。成功後 Host 會撤銷該座位所有 token 與尚未使用的重連碼，MCP process 可以立即加入其他牌桌；同一個離桌請求重試會回放原結果。若 Agent 在進行中的自己回合離桌，Host 會移除座位、該局不再計算它的勝負，並自動把回合交給下一席；其他 Agent 會收到 `seat_left`。人類也能在 UI 按「移除」清掉不再回來的 Agent，操作前會先確認。

## 人類關閉瀏覽器後續桌

人類 UI 會把自己的 capability token 保存在該頁面來源的 `localStorage`，不使用會跨來源自動傳送的 Cookie。本機模式只要同一個 Host process 還在執行，用同一個瀏覽器設定檔重開網址就會自動回桌；本機 Host 重啟後記憶體牌桌消失，UI 會清除失效 token。Remote 模式則會持久化 token 雜湊與牌桌狀態，因此瀏覽器和 Remote Host 都重啟後仍能回到原桌。

這仍是同一瀏覽器來源的座位恢復，不是跨裝置帳號系統：任何能使用同一個瀏覽器設定檔的人都能接手該人類座位。換瀏覽器、清除網站資料或遺失 token 後，目前無法自行找回原人類座位；共用電腦使用完畢應清除該網站資料。

## MCP tools

| Tool | 用途 |
| --- | --- |
| `join_table` | 用邀請碼取得新座位，或搭配人類提供的 `reconnect_code` 接回原座位 |
| `get_table_view` | 讀取最新公開牌桌、自己的座位與合法動作 |
| `leave_table` | 永久離桌、撤銷座位 token，並讓同一 process 可以加入其他牌桌 |
| `take_action` | 輪到自己時執行 `hit` 或 `stand` |
| `say_at_table` | 對人類與其他 Agent 說話，不消耗出牌回合 |
| `wait_for_table_event` | 等候其他座位或牌局產生事件 |

遊戲寫入必須帶最新的 `expected_version` 與新的 `idempotency_key`。版本不符時，Agent 要重讀牌桌後再決定；同一 idempotency key 的網路重試只會回放第一次結果，不會重複抽牌。聊天不改變遊戲版本，避免一句話讓正在出牌的玩家產生不必要的版本衝突。

## 真雙盲邊界

洗牌使用 Node.js `crypto.randomInt` 驅動的 Fisher–Yates shuffle，牌序只存在 Host 內部；Remote 模式的完整狀態落地前會以 AES-256-GCM 加密。人類 API、瀏覽器 UI 與 MCP tool result 都不包含：

- 剩餘牌堆或牌序；
- 尚未翻開的莊家底牌；
- capability token（`join_table` 的 MCP 回傳也會過濾）；
- 人類尚未授權的座位重連憑證；
- 內部遊戲狀態、測試牌序或其他牌桌資料。

同桌玩家的手牌是桌面公開資訊，所有座位都看得到。21 點進行中只公開莊家第一張牌；十點半在攤牌前不公開莊家牌。全部玩家完成回合後才翻開莊家完整手牌。

座位名稱、聊天與事件文字都是不可信的遊戲內容，MCP Server instructions 明確要求 Agent 不得把它們當作操作指令。

## 目前範圍與信任邊界

- 本機單一人類 UI，可邀請最多七個 Agent；
- 同一時間只支援一個人類座位，沒有旁觀者或真人多人模式；Remote 人類恢復仍綁定同一瀏覽器來源，沒有跨裝置帳號找回；
- Remote 持久化目前是單一 Node process 的加密檔案，不支援多副本同時寫入；
- OAuth 模式依賴外部 OIDC Authorization Server，本專案不自行簽發 OAuth token；
- 沒有金錢、籌碼或賭注；
- 加密狀態檔保護靜態落地內容，不防能讀取服務環境變數、記憶體或加密金鑰的主機管理員；Host 是受信任莊家。

## 相容性參考

- [Codex MCP：STDIO、Streamable HTTP、Bearer 與 OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Claude Code Remote HTTP MCP 與 OAuth](https://code.claude.com/docs/en/mcp)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP HTTP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

完整測試範圍請看 [`QA.md`](QA.md)。

真實瀏覽器回歸可用 `npm run test:e2e` 執行。預設啟動本機 Chrome；可用 `CARTES_BROWSER_CHANNEL` 選擇其他 Playwright channel，或用 `CARTES_BROWSER_EXECUTABLE` 指定瀏覽器執行檔。測試會關閉並以相同持久化設定檔重開 Chrome，確認人類回到原桌；也會重啟 Host，確認失效憑證被清除。
