(() => {
  "use strict";

  const TOKEN_KEY = "cartes_human_token";
  const legacyToken = sessionStorage.getItem(TOKEN_KEY) || "";
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || legacyToken,
    table: null,
    polling: null,
    busy: false,
    remote: false,
  };
  if (legacyToken && !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, legacyToken);
  sessionStorage.removeItem(TOKEN_KEY);
  const elements = Object.fromEntries(
    [
      "connectionBadge", "setupPanel", "createForm", "humanName", "tablePanel", "joinCode", "copyInvite",
      "dealerPoints", "dealerCards", "roundLabel", "turnLabel", "playerSeats", "startRound", "hit", "stand",
      "seatCount", "roster", "chatLog", "chatForm", "chatInput", "statusLine", "remoteAccessLabel", "remoteAccessKey",
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
      state.token = result.human_token;
      localStorage.setItem(TOKEN_KEY, state.token);
      setTable(result.table);
      setStatus("牌桌建立完成，把邀請碼交給 Agent 就能入座。");
      startPolling();
    });
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
    state.table = table;
    elements.setupPanel.hidden = true;
    elements.tablePanel.hidden = false;
    elements.connectionBadge.textContent = "本機共桌已連線";
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
    state.token = "";
    state.table = null;
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    elements.setupPanel.hidden = false;
    elements.tablePanel.hidden = true;
    elements.connectionBadge.textContent = "尚未開桌";
    elements.connectionBadge.classList.remove("online");
    setStatus("原本的牌桌已不存在，請重新開桌。", true);
  }

  fetch("/api/remote-config", { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      state.remote = Boolean(config?.remote);
      elements.remoteAccessLabel.hidden = !state.remote;
      elements.remoteAccessKey.required = state.remote;
    })
    .catch(() => {});

  if (state.token) refresh().then(startPolling).catch(() => clearHumanSession());
})();
