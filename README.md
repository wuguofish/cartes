# Cartes MCP 共桌版

這是 [muxihana/cartes](https://github.com/muxihana/cartes) 的 MCP 主線 fork：保留原本完全在瀏覽器運作的單檔牌桌，另外加入 Cartes Host、人類操作 UI，以及可自由選擇的本機 STDIO／自行架設 Streamable HTTP MCP Server，讓一位人類可以直接和多個 Codex／Claude Code Agent 一起玩 21 點或十點半。

## 這個 fork 多了什麼

- 一位人類加最多七個 Agent 的共桌回合制牌局；
- `wait_for_table_event` 長輪詢，讓不同 Agent 知道別家已經加入、說話或出牌；
- Host 獨占洗牌、牌堆與莊家暗牌，瀏覽器和 AI 都拿不到未公開資訊；
- 一次性人類授權重連碼，可由新 MCP process 安全接回原座位、手牌與戰績；
- 人類誤關分頁或瀏覽器後，用同一個瀏覽器重新開啟頁面會自動回到原桌；
- `leave_table` 永久離桌與人類 UI「移除」功能，進行中離桌也會自動交棒，不會卡住牌局；
- optimistic concurrency、冪等寫入、獨立事件游標與多層暗牌洩漏測試；
- 本機 STDIO 零帳號快速開桌，或 Remote MCP 的身分綁定、加密持久化與 Host 重啟續桌；
- 同一 Host 可同時開多桌，營運台能另開分頁、查看座位與安全關桌，但不會顯示暗牌或憑證。
- 發牌、回合交棒與結算有輕量動態回饋；Lottie runtime 與素材皆由 Host 同源提供，不依賴第三方 CDN，並尊重系統的「減少動態效果」設定。

## 五分鐘本機開桌

需求：Node.js 20 以上。

```powershell
npm install
npm start
```

開啟 `http://127.0.0.1:3210` 建立牌桌。另一個終端可以確認 Host：

```powershell
npm run health
```

把 MCP adapter 加到 Codex：

```powershell
codex mcp add cartes -- node D:\絕對路徑\cartes\dist\src\index.js
```

或加到 Claude Code：

```powershell
claude mcp add --transport stdio --scope user cartes -- node D:\絕對路徑\cartes\dist\src\index.js
```

重啟 MCP client 後，在人類 UI 按「複製邀請詞」交給 Agent 即可。不是 Agent 回合時，它應持續呼叫 `wait_for_table_event`；要暫時斷線請走 UI 的安全重連，確定不再保留座位時才呼叫 `leave_table`。

人類座位憑證會依 table ID 保存在 `http://127.0.0.1:3210` 這個瀏覽器來源的 `localStorage`。同一個瀏覽器設定檔可建立多桌，再從營運台把不同牌桌另開分頁。誤關分頁或整個瀏覽器後，只要 Host 沒有停止，用同一個瀏覽器重開網址就能回桌；Host 若已重啟，失效憑證會自動清除。共用電腦上的其他使用者若能開啟同一個瀏覽器設定檔，也能取得這些人類座位，使用完畢請關閉 Host 或清除該網站資料。

## 自行架設 Remote MCP

Remote 模式和本機 STDIO 共用同一套遊戲核心與雙盲視角，但多了 Streamable HTTP、逐請求身分驗證、呼叫者座位綁定，以及 AES-256-GCM 加密狀態檔。服務重啟後，人類可用原瀏覽器座位憑證回桌；Agent 用同一 Bearer／OAuth 身分再次呼叫 `join_table`，會接回原座位。

正式部署必須放在 HTTPS reverse proxy 後方。先執行 `npm run generate:remote-secrets -- friend-1 friend-2 friend-3 friend-4` 產生狀態金鑰、營運管理密碼與每位朋友獨立的 Agent token，把輸出的 Agent JSON 存成不進版控的 `data/remote-keys.json`，再設定：

```powershell
$env:CARTES_PUBLIC_URL="https://cartes.example.com"
$env:CARTES_STATE_KEY="產生的狀態金鑰"
$env:CARTES_HUMAN_ACCESS_KEY="產生的人類建桌密碼"
$env:CARTES_REMOTE_KEYS_FILE="$PWD\data\remote-keys.json"
npm run start:remote
```

### 家用電腦＋Cloudflare Tunnel 開關

Repo 另附 `compose.remote.yml`，預設只映射 `127.0.0.1:3210`，不直接開放 LAN／Internet。將 `.env.remote.example` 複製成不進版控的 `.env.remote`，填入 Cloudflare Tunnel 的固定 HTTPS URL 與剛產生的 secrets；Tunnel 的 service URL 指向 `http://localhost:3210`。

約牌時啟動：

```powershell
.\scripts\Start-CartesRemote.ps1
```

牌局結束後關閉：

```powershell
.\scripts\Stop-CartesRemote.ps1
```

啟動腳本會檢查 Docker daemon、HTTPS URL、管理密碼與每位朋友不同的 Bearer token，然後等到容器 healthcheck 通過。停止腳本執行 `docker compose down`，移除容器與 network，但刻意不傳 `--volumes`，所以 AES 加密牌桌會留在 `cartes-remote_cartes-state` volume；平常也不會留下含環境 secrets 的 stopped container。Compose 設定 `restart: "no"`，Docker Desktop 重啟後不會自己把牌桌服務打開。

Remote 營運管理密碼只存在目前頁面的密碼欄，不寫入 `localStorage`。營運台可列出、另開與關閉多桌；關桌會立即撤銷該桌全部人類／Agent 座位。每位朋友必須使用自己的 Bearer token，同一個身分同時只能占一桌，永久 `leave_table` 或由營運台關桌後才能換桌。

Codex 使用靜態 Bearer token：

```powershell
$env:CARTES_AGENT_TOKEN="remote-keys.json 裡分配給這個 Agent 的 token"
codex mcp add cartes-remote --url https://cartes.example.com/mcp --bearer-token-env-var CARTES_AGENT_TOKEN
```

Claude Code 可保留環境變數占位符，不必把 token 寫入 repo：

```powershell
$env:CARTES_AGENT_TOKEN="remote-keys.json 裡分配給這個 Agent 的 token"
claude mcp add --transport http --scope user cartes-remote https://cartes.example.com/mcp --header 'Authorization: Bearer ${CARTES_AGENT_TOKEN}'
```

若已有 OIDC/OAuth 2.1 provider，可改設 `CARTES_OIDC_ISSUER`、`CARTES_OIDC_AUDIENCE` 與 `CARTES_OIDC_REQUIRED_SCOPE`；Remote Server 會提供 Protected Resource Metadata，Codex／Claude Code 可走各自的 MCP OAuth 登入流程。完整環境變數、TLS、身分模型與安全界線請看 [`docs/MCP.md`](docs/MCP.md)。

## 驗證

```powershell
npm test
npm run test:e2e
npm run typecheck
npm audit --audit-level=high
```

`test:e2e` 使用本機 Chrome，並以持久化測試設定檔驗證關閉、重開瀏覽器後的人類續桌；可用 `CARTES_BROWSER_CHANNEL` 改瀏覽器 channel，或用 `CARTES_BROWSER_EXECUTABLE` 指定執行檔。完整架構、安全界線與操作方式請看 [`docs/MCP.md`](docs/MCP.md)，測試證據請看 [`docs/QA.md`](docs/QA.md)。

## 原版單檔牌桌

原本的 `index.html` 不需要 Node.js 或 Host，仍可獨立使用。它有完整的 21 點與十點半規則、純 CSS 牌面、分模式戰績、角色台詞、求救與桌邊聊天；也能讀取酒館 PNG／JSON 角色卡、Markdown、純文字或直接手填。對話與戰績可以匯出備份，角色卡也能單獨分享。

### 原版開玩三步

1. 打開牌桌網頁，按右上角「設定」。
2. 填入 OpenAI 相容 API 的端點、金鑰與模型名；端點可用快選鈕（Google AI Studio／OpenRouter）一鍵代填，不確定模型名稱時可按「撈清單」。
3. 上傳 PNG／JSON／Markdown／文字角色卡，或直接填角色名與描述。關閉設定後即可開桌。

沒有填完 API 也能正常玩牌，只是莊家暫時不說話。

## 金鑰保母章

Google AI Studio 有免費額度可供入門：

1. 前往 `aistudio.google.com` 並登入 Google 帳號。
2. 選擇「Get API key」。
3. 建立一把 API key，複製到牌桌設定的「金鑰」。
4. 端點填 Google 的 OpenAI 相容出口：`https://generativelanguage.googleapis.com/v1beta/openai`。
5. 按「撈清單」從下拉挑模型，或手動填入可用的模型名。

**建議模型（2026-08-31 時點）**：`gemini-3.1-flash-lite`——快、便宜、實測穩定出話。清單裡有些模型（尤其 preview／thinking／image／tts 系）會沒回應或答非牌桌所問，出不來時先換回這顆再說。

也可以使用 OpenRouter：把它提供的 OpenAI 相容端點、金鑰與模型名填進同樣三格即可。請只使用你信任的 API 供應商。

**酒館 Vertex 用戶**（GCP 300 美試用金那派）：你在 SillyTavern「Vertex AI express」填的那把 `AIza` 開頭金鑰，多半可以直接用——按「Google AI Studio」快選鈕、貼同一把金鑰、撈清單選模型即可（實測可通）。若被拒（403），代表你的 GCP 專案沒開 Generative Language API，去 `aistudio.google.com` 免費補領一把就好。

**金鑰只填在自己瀏覽器裡**：別放進任何雲端筆記、公開貼文、截圖、issue 或公開 repo——金鑰外洩等於把你的額度交給陌生人代刷。

## 原版單檔版的隱私聲明

牌桌是純靜態頁面，沒有站方後端。你的 API 金鑰、角色卡、角色頭像、戰績與最近對話全都存在你自己的瀏覽器 `localStorage`；站方不經手，也沒有可供站方讀取的資料庫。

只有在角色需要開口或你主動撈模型清單時，瀏覽器才會直接向你設定的 API 端點送出請求。共用電腦使用完畢，請到設定按「清除所有資料」。

## 原版單檔版的已知限制

- Anthropic 原生 API 從瀏覽器直連需要額外的跨來源與安全設定，通常建議改走 OpenRouter 等 OpenAI 相容服務。
- 資料存在目前瀏覽器；換瀏覽器、換裝置、使用無痕模式或清除網站資料後，角色記憶不會自動搬家——搬家前用對話視窗的「匯出」帶走記憶，到新家「匯入」還原。
- API 供應商若不允許瀏覽器跨來源請求，莊家會保持安靜，但牌局本身不受影響。
- PNG 角色卡只讀取 `tEXt` 區塊中 key 為 `chara` 的酒館卡資料；未內嵌角色資料的普通圖片不能當角色卡匯入。

## 授權

本專案採用 [MIT License](LICENSE)（Copyright (c) 2026 Muxi / muxihana）。歡迎 fork、改桌布、換規則、加上你自己的角色玩法，再把好點子帶回來。
