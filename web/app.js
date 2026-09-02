(() => {
  "use strict";

  const LEGACY_TOKEN_KEY = "cartes_human_token";
  const TOKENS_KEY = "cartes_human_tokens_v1";
  const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY) || sessionStorage.getItem(LEGACY_TOKEN_KEY) || "";
  const tokens = readTokenMap();
  const requestedTableId = new URL(window.location.href).searchParams.get("table") || "";
  const soleTableId = Object.keys(tokens).length === 1 ? Object.keys(tokens)[0] : "";
  const initialTableId = requestedTableId && tokens[requestedTableId] ? requestedTableId : soleTableId;
  const state = {
    tokens,
    tableId: initialTableId,
    token: (initialTableId && tokens[initialTableId]) || legacyToken,
    table: null,
    polling: null,
    busy: false,
    remote: false,
  };
  sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  const elements = Object.fromEntries(
    [
      "connectionBadge", "setupPanel", "createForm", "humanName", "tablePanel", "joinCode", "copyInvite",
      "dealerPoints", "dealerCards", "roundLabel", "turnLabel", "playerSeats", "startRound", "hit", "stand",
      "seatCount", "roster", "chatLog", "chatForm", "chatInput", "statusLine", "remoteAccessLabel", "remoteAccessKey",
      "managementPanel", "managementList", "managedTableCount", "managementHint", "refreshTables", "backToTables",
    ].map((id) => [id, document.getElementById(id)]),
  );

  elements.createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = new FormData(elements.createForm).get("mode");
    await run(async () => {
      const result = await api("/api/tables", {
        method: "POST",
        body: { mode, human_name: elements.humanName.value.trim() },
        authenticated: false,
        humanAccess: true,
      });
      rememberHumanToken(result.table.table_id, result.human_token);
      selectTable(result.table.table_id, result.human_token);
      setTable(result.table);
      setStatus("牌桌建立完成，把邀請碼交給 Agent 就能入座。");
      startPolling();
    });
  });

  elements.refreshTables.addEventListener("click", () => void run(loadManagement));
  elements.backToTables.addEventListener("click", () => {
    showManagement();
    void loadManagement().catch((error) => setStatus(error.message, true));
  });

  elements.copyInvite.addEventListener("click", async () => {
    if (!state.table) return;
    const prompt = `請使用 cartes MCP，以你的名字加入牌桌 ${state.table.join_code}。加入後先跟阿童打招呼，依 legal_actions 在自己的回合出牌；不是你的回合時呼叫 wait_for_table_event 等待其他玩家。`;
    await navigator.clipboard.writeText(prompt);
    setStatus("邀請詞已複製，可以直接貼給 Codex 或 Claude Code。");
  });

  elements.startRound.addEventListener("click", () => gameWrite("/api/human/start-round", {}));
  elements.hit.addEventListener("click", () => gameWrite("/api/human/action", { action: "hit" }));
  elements.stand.addEventListener("click", () => gameWrite("/api/human/action", { action: "stand" }));

  elements.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = elements.chatInput.value.trim();
    if (!message) return;
    await run(async () => {
      const result = await api("/api/human/say", {
        method: "POST",
        body: { message, idempotency_key: operationKey("human-chat") },
      });
      elements.chatInput.value = "";
      setTable(result.table);
    });
  });

  async function loadManagement() {
    const result = await api("/api/admin/tables", {
      method: "GET",
      authenticated: false,
      humanAccess: true,
    });
    renderManagement(result.tables);
    setStatus(`已載入 ${result.tables.length} 張牌桌。`);
  }

  function renderManagement(tables) {
    elements.managedTableCount.textContent = `${tables.length} 桌`;
    elements.managementHint.textContent = tables.length
      ? "每張牌桌可另開分頁；只有保存在這個瀏覽器裡的人類座位能進桌操作。"
      : "目前沒有牌桌。建立後會在這裡顯示，但不會列出暗牌或任何座位憑證。";
    elements.managementList.replaceChildren(...tables.map((table) => {
      const article = document.createElement("article");
      article.className = "management-card";

      const heading = document.createElement("div");
      heading.className = "management-card-heading";
      const title = document.createElement("div");
      const code = document.createElement("strong");
      code.textContent = table.join_code;
      const rule = document.createElement("span");
      rule.textContent = `${table.rule_label} · ${phaseLabel(table)}`;
      title.append(code, rule);
      const count = document.createElement("span");
      count.className = "count-pill";
      count.textContent = `${table.player_count}/${table.max_seats}`;
      heading.append(title, count);

      const players = document.createElement("p");
      players.className = "management-players";
      players.textContent = table.players.map((seat) => `${seat.name}${seat.kind === "human" ? "（人類）" : ""}`).join("、");

      const actions = document.createElement("div");
      actions.className = "management-actions";
      const token = state.tokens[table.table_id];
      if (token) {
        const open = document.createElement("a");
        open.className = "secondary-button management-open";
        open.href = tableUrl(table.table_id);
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = "另開牌桌";
        actions.append(open);
      } else {
        const unavailable = document.createElement("span");
        unavailable.className = "management-unavailable";
        unavailable.textContent = "此瀏覽器沒有該桌人類座位";
        actions.append(unavailable);
      }
      const close = document.createElement("button");
      close.type = "button";
      close.className = "danger-button";
      close.textContent = "關閉牌桌";
      close.addEventListener("click", () => void closeManagedTable(table));
      actions.append(close);

      article.append(heading, players, actions);
      return article;
    }));
  }

  async function closeManagedTable(table) {
    if (!window.confirm(`確定要關閉牌桌 ${table.join_code} 嗎？所有人類與 Agent 座位都會立即失效。`)) return;
    await run(async () => {
      await api(`/api/admin/tables/${encodeURIComponent(table.table_id)}`, {
        method: "DELETE",
        authenticated: false,
        humanAccess: true,
      });
      forgetHumanToken(table.table_id);
      if (state.tableId === table.table_id) showManagement();
      await loadManagement();
      setStatus(`牌桌 ${table.join_code} 已關閉，所有座位憑證均已撤銷。`);
    });
  }

  function phaseLabel(table) {
    if (table.phase === "lobby") return "等待開局";
    if (table.phase === "ended") return `第 ${table.round} 局已結束`;
    return table.active_player_name ? `輪到 ${table.active_player_name}` : "進行中";
  }

  async function gameWrite(path, extra) {
    if (!state.table) return;
    await run(async () => {
      try {
        const result = await api(path, {
          method: "POST",
          body: { ...extra, expected_version: state.table.version, idempotency_key: operationKey("human-game") },
        });
        setTable(result.table);
      } catch (error) {
        await refresh(true);
        throw error;
      }
    });
  }

  async function refresh(force = false) {
    if (!state.token || (state.busy && !force)) return;
    const result = await api("/api/human/table", { method: "GET" });
    setTable(result.table);
  }

  function startPolling() {
    clearInterval(state.polling);
    state.polling = setInterval(() => void refresh().catch((error) => {
      if (error.status === 401) {
        clearHumanSession();
        return;
      }
      setStatus(error.message, true);
    }), 800);
  }

  function setTable(table) {
    if (!state.tableId || state.tableId !== table.table_id) {
      state.tableId = table.table_id;
      if (state.token) rememberHumanToken(table.table_id, state.token);
    }
    state.table = table;
    elements.setupPanel.hidden = true;
    elements.managementPanel.hidden = true;
    elements.tablePanel.hidden = false;
    elements.connectionBadge.textContent = state.remote ? "Remote 共桌已連線" : "本機共桌已連線";
    elements.connectionBadge.classList.add("online");
    elements.joinCode.textContent = table.join_code;
    elements.roundLabel.textContent = table.round ? `第 ${table.round} 局 · ${table.rule_label}` : `${table.rule_label} · 等待開局`;
    elements.seatCount.textContent = String(table.players.length);

    const active = table.players.find((seat) => seat.seat_id === table.active_seat_id);
    elements.turnLabel.textContent = table.phase === "lobby"
      ? "等待 Agent 入座"
      : table.phase === "ended"
        ? "本局結束，可以再開一局"
        : active
          ? `輪到 ${active.name}`
          : "莊家結算中";

    renderDealer(table);
    renderPlayers(table);
    renderRoster(table);
    renderChat(table);

    elements.startRound.hidden = !table.legal_actions.includes("start_round");
    elements.hit.hidden = table.phase !== "player_turns";
    elements.stand.hidden = table.phase !== "player_turns";
    elements.hit.disabled = state.busy || !table.legal_actions.includes("hit");
    elements.stand.disabled = state.busy || !table.legal_actions.includes("stand");
    elements.startRound.disabled = state.busy;
  }

  function showManagement() {
    clearInterval(state.polling);
    state.polling = null;
    state.table = null;
    state.tableId = "";
    state.token = "";
    const url = new URL(window.location.href);
    url.searchParams.delete("table");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    elements.setupPanel.hidden = false;
    elements.managementPanel.hidden = false;
    elements.tablePanel.hidden = true;
    elements.connectionBadge.textContent = "多桌營運台";
    elements.connectionBadge.classList.remove("online");
  }

  function selectTable(tableId, token) {
    state.tableId = tableId;
    state.token = token;
    const url = new URL(window.location.href);
    url.searchParams.set("table", tableId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function tableUrl(tableId) {
    const url = new URL(window.location.href);
    url.searchParams.set("table", tableId);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function readTokenMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TOKENS_KEY) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([tableId, token]) => tableId && typeof token === "string" && token));
    } catch {
      return {};
    }
  }

  function rememberHumanToken(tableId, token) {
    state.tokens[tableId] = token;
    localStorage.setItem(TOKENS_KEY, JSON.stringify(state.tokens));
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  }

  function forgetHumanToken(tableId) {
    delete state.tokens[tableId];
    if (Object.keys(state.tokens).length) localStorage.setItem(TOKENS_KEY, JSON.stringify(state.tokens));
    else localStorage.removeItem(TOKENS_KEY);
  }

  function renderDealer(table) {
    const cards = table.dealer.cards.map(cardElement);
    if (!table.dealer.hole_revealed && table.phase === "player_turns") cards.push(hiddenCard());
    elements.dealerCards.replaceChildren(...cards);
    elements.dealerPoints.textContent = table.dealer.points === null ? "蓋牌" : `${table.dealer.points} 點`;
  }

  function renderPlayers(table) {
    elements.playerSeats.replaceChildren(...table.players.map((seat) => {
      const article = document.createElement("article");
      article.className = `player-seat${seat.seat_id === table.active_seat_id ? " active" : ""}${seat.is_you ? " yours" : ""}`;
      const heading = document.createElement("div");
      heading.className = "seat-heading";
      const name = document.createElement("strong");
      name.textContent = `${seat.name}${seat.is_you ? "（你）" : ""}`;
      const points = document.createElement("span");
      points.textContent = seat.cards.length ? `${seat.points} 點` : "尚未發牌";
      heading.append(name, points);
      const cards = document.createElement("div");
      cards.className = "cards compact";
      cards.replaceChildren(...seat.cards.map(cardElement));
      const result = document.createElement("p");
      result.className = "seat-result";
      result.textContent = resultText(seat);
      article.append(heading, cards, result);
      return article;
    }));
  }

  function renderRoster(table) {
    elements.roster.replaceChildren(...table.players.map((seat) => {
      const row = document.createElement("div");
      row.className = "roster-row";
      const dot = document.createElement("span");
      dot.className = `roster-dot ${seat.kind}`;
      const label = document.createElement("span");
      label.textContent = seat.name;
      const kind = document.createElement("small");
      kind.textContent = seat.kind === "human" ? "人類" : "Agent";
      row.append(dot, label, kind);
      if (seat.kind === "agent") {
        const reconnect = document.createElement("button");
        reconnect.type = "button";
        reconnect.className = "seat-reconnect";
        reconnect.textContent = "重連";
        reconnect.title = `替 ${seat.name} 產生一次性重連邀請`;
        reconnect.disabled = state.busy;
        reconnect.addEventListener("click", () => void createReconnectPrompt(seat));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "seat-remove";
        remove.textContent = "移除";
        remove.title = `將 ${seat.name} 永久移出牌桌`;
        remove.disabled = state.busy;
        remove.addEventListener("click", () => void removeAgentSeat(seat));
        row.append(reconnect, remove);
      }
      return row;
    }));
  }

  async function createReconnectPrompt(seat) {
    await run(async () => {
      const ticket = await api("/api/human/reconnect-code", {
        method: "POST",
        body: { seat_id: seat.seat_id },
      });
      const prompt = `請使用 cartes MCP，以「${seat.name}」重新連回牌桌 ${state.table.join_code}，並在 join_table 傳入 reconnect_code「${ticket.reconnect_code}」。重連後依 legal_actions 出牌；不是你的回合時呼叫 wait_for_table_event，並持續參與後續牌局直到阿童結束測試。`;
      await navigator.clipboard.writeText(prompt);
      setStatus(`${seat.name} 的一次性重連邀請已複製，10 分鐘內有效。`);
    });
  }

  async function removeAgentSeat(seat) {
    if (!window.confirm(`確定要將 ${seat.name} 永久移出牌桌嗎？進行中的牌局會自動交棒給下一位玩家。`)) return;
    await run(async () => {
      const result = await api("/api/human/remove-agent", {
        method: "POST",
        body: {
          seat_id: seat.seat_id,
          expected_version: state.table.version,
          idempotency_key: operationKey("human-remove-agent"),
        },
      });
      setTable(result.table);
      setStatus(`${seat.name} 已離開牌桌。`);
    });
  }

  function renderChat(table) {
    const nearBottom = elements.chatLog.scrollHeight - elements.chatLog.scrollTop - elements.chatLog.clientHeight < 40;
    elements.chatLog.replaceChildren(...table.recent_chat.map((message) => {
      const bubble = document.createElement("div");
      bubble.className = `chat-bubble ${message.speaker_kind}`;
      const name = document.createElement("strong");
      name.textContent = message.speaker;
      const text = document.createElement("p");
      text.textContent = message.text;
      bubble.append(name, text);
      return bubble;
    }));
    if (nearBottom) elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }

  function cardElement(code) {
    const card = document.createElement("div");
    const suit = code.slice(0, 1);
    card.className = `playing-card${suit === "♥" || suit === "♦" ? " red" : ""}`;
    const rank = document.createElement("strong");
    rank.textContent = code.slice(1);
    const mark = document.createElement("span");
    mark.textContent = suit;
    card.append(rank, mark);
    return card;
  }

  function hiddenCard() {
    const card = document.createElement("div");
    card.className = "playing-card hidden-card";
    card.setAttribute("aria-label", "暗牌");
    return card;
  }

  function resultText(seat) {
    if (seat.result) {
      if (seat.result.outcome === "player") return "本局勝出";
      if (seat.result.outcome === "dealer") return "本局莊勝";
      return "本局平手";
    }
    return ({ active: "正在行動", waiting: "等待回合", stood: "已停牌", bust: "爆牌" })[seat.status] || "";
  }

  async function api(path, options) {
    const headers = { Accept: "application/json" };
    if (options.body) headers["Content-Type"] = "application/json";
    if (options.authenticated !== false) headers.Authorization = `Bearer ${state.token}`;
    if (options.humanAccess && state.remote) headers["X-Cartes-Human-Key"] = elements.remoteAccessKey.value;
    const response = await fetch(path, {
      method: options.method,
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function run(operation) {
    if (state.busy) return;
    state.busy = true;
    if (state.table) setTable(state.table);
    try {
      await operation();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      state.busy = false;
      if (state.table) setTable(state.table);
    }
  }

  function operationKey(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  function setStatus(message, error = false) {
    elements.statusLine.textContent = message;
    elements.statusLine.classList.toggle("error", error);
  }

  function clearHumanSession() {
    clearInterval(state.polling);
    state.polling = null;
    if (state.tableId) forgetHumanToken(state.tableId);
    state.token = "";
    state.tableId = "";
    state.table = null;
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
    showManagement();
    setStatus("原本的牌桌已不存在，請重新開桌。", true);
  }

  fetch("/api/remote-config", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      state.remote = Boolean(config?.remote);
      elements.remoteAccessLabel.hidden = !state.remote;
      elements.remoteAccessKey.required = state.remote;
      if (!state.token && !state.remote) return loadManagement();
      return null;
    })
    .catch((error) => {
      if (!state.remote) setStatus(error instanceof Error ? error.message : String(error), true);
    });

  if (state.token) {
    refresh().then(() => {
      if (state.table && state.token) {
        rememberHumanToken(state.table.table_id, state.token);
        selectTable(state.table.table_id, state.token);
      }
      startPolling();
    }).catch(() => clearHumanSession());
  } else {
    showManagement();
  }
})();
