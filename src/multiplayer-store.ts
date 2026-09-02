import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  classifyHand,
  compareHands,
  parseCard,
  type Card,
  type GameAction,
  type GameMode,
  type GameResult,
  RULES,
  scoreHand,
  shuffledDeck,
} from "./game.js";

export type TablePhase = "lobby" | "player_turns" | "ended";
export type SeatKind = "human" | "agent";
export type SeatStatus = "waiting" | "active" | "stood" | "bust";
export type PublicAction = GameAction | "start_round";
export type TableEventKind =
  | "table_created"
  | "seat_joined"
  | "seat_left"
  | "seat_reconnected"
  | "round_started"
  | "turn_started"
  | "player_hit"
  | "player_stood"
  | "player_bust"
  | "round_ended"
  | "message";

export interface SeatResult {
  readonly outcome: GameResult["outcome"];
  readonly special: GameResult["special"];
  readonly player_points: number;
  readonly dealer_points: number;
}

export interface PublicSeatView {
  readonly seat_id: string;
  readonly name: string;
  readonly kind: SeatKind;
  readonly cards: string[];
  readonly points: number;
  readonly status: SeatStatus;
  readonly is_you: boolean;
  readonly result: SeatResult | null;
  readonly records: { player: number; dealer: number; push: number };
}

export interface PublicChatMessage {
  readonly event_id: number;
  readonly seat_id: string;
  readonly speaker: string;
  readonly speaker_kind: SeatKind;
  readonly text: string;
  readonly at: string;
}

export interface TableEvent {
  readonly event_id: number;
  readonly kind: TableEventKind;
  readonly round: number;
  readonly actor_seat_id: string | null;
  readonly actor_name: string | null;
  readonly text: string;
  readonly at: string;
}

export interface PublicTableView {
  readonly table_id: string;
  readonly join_code: string;
  readonly mode: GameMode;
  readonly rule_label: string;
  readonly phase: TablePhase;
  readonly version: number;
  readonly round: number;
  readonly viewer_seat_id: string;
  readonly active_seat_id: string | null;
  readonly players: PublicSeatView[];
  readonly dealer: {
    readonly cards: string[];
    readonly points: number | null;
    readonly hole_revealed: boolean;
  };
  readonly legal_actions: PublicAction[];
  readonly recent_chat: PublicChatMessage[];
  readonly last_event_id: number;
}

export interface AgentJoinResult {
  readonly agent_token: string;
  readonly table: PublicTableView;
}

export interface AgentReconnectTicket {
  readonly reconnect_code: string;
  readonly expires_at: string;
  readonly seat_id: string;
  readonly agent_name: string;
}

export interface AgentLeaveResult {
  readonly left: true;
  readonly table_id: string;
  readonly join_code: string;
  readonly seat_id: string;
  readonly agent_name: string;
}

export interface HumanTableResult {
  readonly human_token: string;
  readonly table: PublicTableView;
}

export interface AgentEventResult {
  readonly timed_out: boolean;
  readonly events: TableEvent[];
  readonly table: PublicTableView;
}

interface Seat {
  readonly id: string;
  readonly kind: SeatKind;
  readonly name: string;
  readonly cards: Card[];
  status: SeatStatus;
  result: SeatResult | null;
  readonly records: { player: number; dealer: number; push: number };
  principalId: string | null;
}

interface Receipt<T> {
  readonly operation: string;
  readonly value: T;
}

interface AgentSession {
  readonly tokenHash: string;
  readonly seatId: string;
  cursor: number;
}

interface Waiter {
  readonly resolve: (result: AgentEventResult) => void;
  readonly timer: NodeJS.Timeout;
}

interface ReconnectTicket {
  readonly seatId: string;
  readonly expiresAtMs: number;
}

interface Table {
  readonly id: string;
  readonly joinCode: string;
  readonly humanTokenHash: string;
  readonly mode: GameMode;
  phase: TablePhase;
  version: number;
  round: number;
  deck: Card[];
  dealerCards: Card[];
  holeRevealed: boolean;
  activeSeatId: string | null;
  readonly seats: Seat[];
  readonly agentSessions: Map<string, AgentSession>;
  readonly events: TableEvent[];
  readonly chat: PublicChatMessage[];
  nextEventId: number;
  readonly receipts: Map<string, Receipt<unknown>>;
  readonly waiters: Map<string, Waiter>;
  readonly reconnectTickets: Map<string, ReconnectTicket>;
}

export interface MultiplayerTablePersistence {
  load(): unknown | null;
  save(snapshot: unknown): void;
}

export interface MultiplayerTableStoreOptions {
  readonly persistence?: MultiplayerTablePersistence;
}

export type MultiplayerDeckFactory = (mode: GameMode, round: number, seatCount: number) => readonly (Card | string)[];

const MAX_SEATS = 8;
const EVENT_CAP = 500;
const CHAT_CAP = 100;
const RECONNECT_TICKET_TTL_MS = 10 * 60 * 1000;
const LEAVE_RECEIPT_CAP = 1_000;

export class MultiplayerTableStore {
  readonly #tables = new Map<string, Table>();
  readonly #joinCodes = new Map<string, string>();
  readonly #agentTokens = new Map<string, string>();
  readonly #humanTokens = new Map<string, string>();
  readonly #departedAgentTokens = new Map<string, AgentLeaveResult>();
  readonly #principalSeats = new Map<string, { tableId: string; seatId: string }>();
  readonly #deckFactory: MultiplayerDeckFactory;
  readonly #persistence: MultiplayerTablePersistence | undefined;

  constructor(
    deckFactory: MultiplayerDeckFactory = () => shuffledDeck(),
    options: MultiplayerTableStoreOptions = {},
  ) {
    this.#deckFactory = deckFactory;
    this.#persistence = options.persistence;
    const snapshot = this.#persistence?.load();
    if (snapshot) this.#restore(snapshot);
  }

  createTable(mode: GameMode, humanName: string): HumanTableResult {
    const id = randomUUID();
    const humanToken = capabilityToken();
    const joinCode = this.#newJoinCode();
    const humanSeat: Seat = {
      id: randomUUID(),
      kind: "human",
      name: normalizeName(humanName, "玩家"),
      cards: [],
      status: "waiting",
      result: null,
      records: { player: 0, dealer: 0, push: 0 },
      principalId: null,
    };
    const table: Table = {
      id,
      joinCode,
      humanTokenHash: capabilityHash(humanToken),
      mode,
      phase: "lobby",
      version: 1,
      round: 0,
      deck: [],
      dealerCards: [],
      holeRevealed: false,
      activeSeatId: null,
      seats: [humanSeat],
      agentSessions: new Map(),
      events: [],
      chat: [],
      nextEventId: 1,
      receipts: new Map(),
      waiters: new Map(),
      reconnectTickets: new Map(),
    };
    this.#tables.set(id, table);
    this.#joinCodes.set(joinCode, id);
    this.#humanTokens.set(table.humanTokenHash, id);
    this.#appendEvent(table, "table_created", humanSeat, `${humanSeat.name} 建立了牌桌。`);
    this.#persist();
    return { human_token: humanToken, table: this.#view(table, humanSeat.id) };
  }

  joinAgent(joinCode: string, agentName: string): AgentJoinResult {
    return this.#joinNewAgent(this.#tableForJoinCode(joinCode), agentName, null);
  }

  joinAgentForPrincipal(joinCode: string, agentName: string, principalId: string): AgentJoinResult {
    const normalizedPrincipal = normalizePrincipal(principalId);
    const table = this.#tableForJoinCode(joinCode);
    const binding = this.#principalSeats.get(normalizedPrincipal);
    if (binding) {
      const boundTable = this.#tables.get(binding.tableId);
      const boundSeat = boundTable?.seats.find((seat) => seat.id === binding.seatId);
      if (!boundTable || !boundSeat || boundSeat.kind !== "agent") {
        this.#principalSeats.delete(normalizedPrincipal);
      } else {
        if (boundTable.id !== table.id) throw new Error("這個遠端 MCP 身分已經綁定另一張牌桌的座位。");
        if (boundSeat.name !== normalizeName(agentName, "AI 玩家")) {
          throw new Error("這個遠端 MCP 身分與既有 Agent 名稱不符。");
        }
        return this.#reconnectSeat(table, boundSeat, normalizedPrincipal);
      }
    }
    return this.#joinNewAgent(table, agentName, normalizedPrincipal);
  }

  #joinNewAgent(table: Table, agentName: string, principalId: string | null): AgentJoinResult {
    if (table.phase === "player_turns") throw new Error("本局已經開始，請等牌局結束後再加入。");
    if (table.seats.length >= MAX_SEATS) throw new Error(`這張牌桌最多 ${MAX_SEATS} 個座位。`);
    const name = normalizeName(agentName, "AI 玩家");
    if (table.seats.some((seat) => seat.name === name)) throw new Error("牌桌上已經有同名玩家。");
    const seat: Seat = {
      id: randomUUID(),
      kind: "agent",
      name,
      cards: [],
      status: "waiting",
      result: null,
      records: { player: 0, dealer: 0, push: 0 },
      principalId,
    };
    const token = capabilityToken();
    const tokenHash = capabilityHash(token);
    const session: AgentSession = { tokenHash, seatId: seat.id, cursor: table.nextEventId - 1 };
    table.seats.push(seat);
    table.agentSessions.set(tokenHash, session);
    this.#agentTokens.set(tokenHash, table.id);
    if (principalId) this.#principalSeats.set(principalId, { tableId: table.id, seatId: seat.id });
    table.version += 1;
    this.#appendEvent(table, "seat_joined", seat, `${seat.name} 加入了牌桌。`);
    session.cursor = table.nextEventId - 1;
    const result = { agent_token: token, table: this.#view(table, seat.id) };
    this.#flushWaiters(table);
    this.#persist();
    return result;
  }

  createAgentReconnectTicket(humanToken: string, seatId: string): AgentReconnectTicket {
    const table = this.#tableForHuman(humanToken);
    const seat = this.#requireSeat(table, seatId);
    if (seat.kind !== "agent") throw new Error("只能替 Agent 座位產生重連碼。");
    for (const [code, ticket] of table.reconnectTickets) {
      if (ticket.seatId === seat.id || ticket.expiresAtMs <= Date.now()) table.reconnectTickets.delete(code);
    }
    let code: string;
    do {
      code = randomBytes(9).toString("base64url").toUpperCase();
    } while (table.reconnectTickets.has(capabilityHash(code)));
    const expiresAtMs = Date.now() + RECONNECT_TICKET_TTL_MS;
    table.reconnectTickets.set(capabilityHash(code), { seatId: seat.id, expiresAtMs });
    this.#persist();
    return {
      reconnect_code: code,
      expires_at: new Date(expiresAtMs).toISOString(),
      seat_id: seat.id,
      agent_name: seat.name,
    };
  }

  rejoinAgent(joinCode: string, agentName: string, reconnectCode: string): AgentJoinResult {
    const table = this.#tableForJoinCode(joinCode);
    const codeHash = capabilityHash(reconnectCode.trim().toUpperCase());
    const ticket = table.reconnectTickets.get(codeHash);
    if (!ticket || ticket.expiresAtMs <= Date.now()) {
      if (ticket) table.reconnectTickets.delete(codeHash);
      throw new Error("重連碼無效或已過期，請由人類玩家重新產生。");
    }
    const seat = this.#requireSeat(table, ticket.seatId);
    if (seat.kind !== "agent" || seat.name !== normalizeName(agentName, "AI 玩家")) {
      throw new Error("重連碼與 Agent 座位不符。");
    }
    if (seat.principalId) throw new Error("這個座位已綁定遠端 MCP 身分，請用原身分重新連線。");
    table.reconnectTickets.delete(codeHash);
    return this.#reconnectSeat(table, seat, null);
  }

  rejoinAgentForPrincipal(
    joinCode: string,
    agentName: string,
    reconnectCode: string,
    principalId: string,
  ): AgentJoinResult {
    const table = this.#tableForJoinCode(joinCode);
    const normalizedPrincipal = normalizePrincipal(principalId);
    const codeHash = capabilityHash(reconnectCode.trim().toUpperCase());
    const ticket = table.reconnectTickets.get(codeHash);
    if (!ticket || ticket.expiresAtMs <= Date.now()) {
      if (ticket) table.reconnectTickets.delete(codeHash);
      throw new Error("重連碼無效或已過期，請由人類玩家重新產生。");
    }
    const seat = this.#requireSeat(table, ticket.seatId);
    if (seat.kind !== "agent" || seat.name !== normalizeName(agentName, "AI 玩家")) {
      throw new Error("重連碼與 Agent 座位不符。");
    }
    if (seat.principalId && seat.principalId !== normalizedPrincipal) {
      throw new Error("這個座位已綁定另一個遠端 MCP 身分。");
    }
    const existing = this.#principalSeats.get(normalizedPrincipal);
    if (existing && (existing.tableId !== table.id || existing.seatId !== seat.id)) {
      throw new Error("這個遠端 MCP 身分已經綁定另一個座位。");
    }
    table.reconnectTickets.delete(codeHash);
    return this.#reconnectSeat(table, seat, normalizedPrincipal);
  }

  #reconnectSeat(table: Table, seat: Seat, principalId: string | null): AgentJoinResult {
    for (const [token, session] of table.agentSessions) {
      if (session.seatId !== seat.id) continue;
      const waiter = table.waiters.get(token);
      if (waiter) {
        clearTimeout(waiter.timer);
        table.waiters.delete(token);
        waiter.resolve(this.#eventResult(table, session, [], true));
      }
      table.agentSessions.delete(token);
      this.#agentTokens.delete(token);
    }
    const token = capabilityToken();
    const tokenHash = capabilityHash(token);
    const session: AgentSession = { tokenHash, seatId: seat.id, cursor: table.nextEventId - 1 };
    table.agentSessions.set(tokenHash, session);
    this.#agentTokens.set(tokenHash, table.id);
    if (principalId) {
      seat.principalId = principalId;
      this.#principalSeats.set(principalId, { tableId: table.id, seatId: seat.id });
    }
    this.#appendEvent(table, "seat_reconnected", seat, `${seat.name} 重新連回牌桌。`);
    session.cursor = table.nextEventId - 1;
    const result = { agent_token: token, table: this.#view(table, seat.id) };
    this.#flushWaiters(table);
    this.#persist();
    return result;
  }

  getHumanView(humanToken: string): PublicTableView {
    const table = this.#tableForHuman(humanToken);
    return this.#view(table, table.seats[0]!.id);
  }

  getAgentView(agentToken: string): PublicTableView {
    const { table, session } = this.#tableForAgent(agentToken);
    return this.#view(table, session.seatId);
  }

  leaveAgent(agentToken: string): AgentLeaveResult {
    const replay = this.#departedAgentTokens.get(capabilityHash(agentToken));
    if (replay) return structuredClone(replay);
    const { table, session } = this.#tableForAgent(agentToken);
    const seat = this.#requireSeat(table, session.seatId);
    const result = this.#leaveResult(table, seat);
    this.#removeAgentSeat(table, seat, `${seat.name} 離開了牌桌。`, result);
    this.#persist();
    return result;
  }

  removeAgentSeat(
    humanToken: string,
    seatId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): PublicTableView {
    const table = this.#tableForHuman(humanToken);
    const humanSeat = table.seats[0]!;
    const operation = `remove_agent:${seatId}`;
    const replay = this.#replay<PublicTableView>(table, humanSeat.id, idempotencyKey, operation);
    if (replay) return replay;
    this.#assertVersion(table, expectedVersion);
    const seat = this.#requireSeat(table, seatId);
    if (seat.kind !== "agent") throw new Error("只能移除 Agent 座位。");
    this.#removeAgentSeat(table, seat, `${seat.name} 被人類玩家移出牌桌。`, this.#leaveResult(table, seat));
    const result = this.#remember(table, humanSeat.id, idempotencyKey, operation, this.#view(table, humanSeat.id));
    this.#persist();
    return result;
  }

  startRound(humanToken: string, expectedVersion: number, idempotencyKey: string): PublicTableView {
    const table = this.#tableForHuman(humanToken);
    const humanSeat = table.seats[0]!;
    const operation = "start_round";
    const replay = this.#replay<PublicTableView>(table, humanSeat.id, idempotencyKey, operation);
    if (replay) return replay;
    this.#assertVersion(table, expectedVersion);
    if (table.phase === "player_turns") throw new Error("目前牌局還沒結束。");

    table.round += 1;
    table.deck = this.#deckFactory(table.mode, table.round, table.seats.length).map((card) =>
      typeof card === "string" ? parseCard(card) : card,
    );
    table.dealerCards = [];
    table.holeRevealed = false;
    table.activeSeatId = null;
    for (const seat of table.seats) {
      seat.cards.splice(0);
      seat.status = "waiting";
      seat.result = null;
    }
    const openingCards = RULES[table.mode].openingCards;
    for (let index = 0; index < openingCards; index += 1) {
      for (const seat of table.seats) seat.cards.push(this.#draw(table));
      table.dealerCards.push(this.#draw(table));
    }
    for (const seat of table.seats) {
      if (classifyHand(table.mode, seat.cards).kind === "blackjack") seat.status = "stood";
    }
    table.phase = "player_turns";
    table.version += 1;
    this.#appendEvent(table, "round_started", null, `第 ${table.round} 局開始。`);
    this.#activateNextSeat(table, -1);
    const result = this.#remember(table, humanSeat.id, idempotencyKey, operation, this.#view(table, humanSeat.id));
    this.#flushWaiters(table);
    this.#persist();
    return result;
  }

  humanAction(
    humanToken: string,
    action: GameAction,
    expectedVersion: number,
    idempotencyKey: string,
  ): PublicTableView {
    const table = this.#tableForHuman(humanToken);
    return this.#seatAction(table, table.seats[0]!, action, expectedVersion, idempotencyKey);
  }

  agentAction(
    agentToken: string,
    action: GameAction,
    expectedVersion: number,
    idempotencyKey: string,
  ): PublicTableView {
    const { table, session } = this.#tableForAgent(agentToken);
    const seat = this.#requireSeat(table, session.seatId);
    return this.#seatAction(table, seat, action, expectedVersion, idempotencyKey);
  }

  humanSay(humanToken: string, text: string, idempotencyKey: string): PublicTableView {
    const table = this.#tableForHuman(humanToken);
    return this.#say(table, table.seats[0]!, text, idempotencyKey);
  }

  agentSay(agentToken: string, text: string, idempotencyKey: string): PublicTableView {
    const { table, session } = this.#tableForAgent(agentToken);
    return this.#say(table, this.#requireSeat(table, session.seatId), text, idempotencyKey);
  }

  async waitForAgentEvents(agentToken: string, timeoutMs: number): Promise<AgentEventResult> {
    const { table, session } = this.#tableForAgent(agentToken);
    const immediate = this.#consumeUnreadEvents(table, session);
    if (immediate.length) {
      this.#persist();
      return this.#eventResult(table, session, immediate, false);
    }
    if (table.waiters.has(session.tokenHash)) throw new Error("這個 Agent 已經有一個等待中的事件請求。");
    const boundedTimeout = Math.max(0, Math.min(timeoutMs, 25_000));
    if (boundedTimeout === 0) return this.#eventResult(table, session, [], true);
    return new Promise<AgentEventResult>((resolve) => {
      const timer = setTimeout(() => {
        table.waiters.delete(session.tokenHash);
        resolve(this.#eventResult(table, session, [], true));
      }, boundedTimeout);
      table.waiters.set(session.tokenHash, { resolve, timer });
    });
  }

  #seatAction(
    table: Table,
    seat: Seat,
    action: GameAction,
    expectedVersion: number,
    idempotencyKey: string,
  ): PublicTableView {
    const operation = `take_action:${action}`;
    const replay = this.#replay<PublicTableView>(table, seat.id, idempotencyKey, operation);
    if (replay) return replay;
    this.#assertVersion(table, expectedVersion);
    if (table.phase !== "player_turns" || table.activeSeatId !== seat.id || seat.status !== "active") {
      throw new Error("現在不是你的回合。");
    }

    if (action === "hit") {
      const card = this.#draw(table);
      seat.cards.push(card);
      this.#appendEvent(table, "player_hit", seat, `${seat.name} 要牌，拿到 ${card.code}。`);
      const hand = classifyHand(table.mode, seat.cards);
      if (hand.kind === "bust") {
        seat.status = "bust";
        this.#appendEvent(table, "player_bust", seat, `${seat.name} 爆牌。`);
        this.#activateNextSeat(table, table.seats.indexOf(seat));
      } else if (table.mode === "tenhalf" && (hand.kind === "tenhalf" || hand.kind === "fivedragon")) {
        seat.status = "stood";
        this.#appendEvent(table, "player_stood", seat, `${seat.name} 自動停牌。`);
        this.#activateNextSeat(table, table.seats.indexOf(seat));
      }
    } else {
      seat.status = "stood";
      this.#appendEvent(table, "player_stood", seat, `${seat.name} 停牌。`);
      this.#activateNextSeat(table, table.seats.indexOf(seat));
    }
    table.version += 1;
    const result = this.#remember(table, seat.id, idempotencyKey, operation, this.#view(table, seat.id));
    this.#flushWaiters(table);
    this.#persist();
    return result;
  }

  #say(table: Table, seat: Seat, text: string, idempotencyKey: string): PublicTableView {
    const normalized = text.trim().slice(0, 500);
    if (!normalized) throw new Error("台詞不能是空白。");
    const operation = `say:${normalized}`;
    const replay = this.#replay<PublicTableView>(table, seat.id, idempotencyKey, operation);
    if (replay) return replay;
    const event = this.#appendEvent(table, "message", seat, normalized);
    table.chat.push({
      event_id: event.event_id,
      seat_id: seat.id,
      speaker: seat.name,
      speaker_kind: seat.kind,
      text: normalized,
      at: event.at,
    });
    if (table.chat.length > CHAT_CAP) table.chat.splice(0, table.chat.length - CHAT_CAP);
    const result = this.#remember(table, seat.id, idempotencyKey, operation, this.#view(table, seat.id));
    this.#flushWaiters(table);
    this.#persist();
    return result;
  }

  #removeAgentSeat(table: Table, seat: Seat, text: string, leaveResult: AgentLeaveResult): void {
    if (seat.kind !== "agent") throw new Error("人類玩家不能離開自己的牌桌。");
    const seatIndex = table.seats.indexOf(seat);
    if (seatIndex < 0) throw new Error("找不到這個座位。");
    const wasActive = table.phase === "player_turns" && table.activeSeatId === seat.id;

    for (const [token, session] of table.agentSessions) {
      if (session.seatId !== seat.id) continue;
      const waiter = table.waiters.get(token);
      if (waiter) {
        clearTimeout(waiter.timer);
        table.waiters.delete(token);
        waiter.resolve(this.#eventResult(table, session, [], true));
      }
      table.agentSessions.delete(token);
      this.#agentTokens.delete(token);
      this.#rememberDepartedToken(token, leaveResult);
    }
    for (const [code, ticket] of table.reconnectTickets) {
      if (ticket.seatId === seat.id) table.reconnectTickets.delete(code);
    }
    if (seat.principalId) this.#principalSeats.delete(seat.principalId);
    for (const receiptKey of table.receipts.keys()) {
      if (receiptKey.startsWith(`${seat.id}:`)) table.receipts.delete(receiptKey);
    }

    table.seats.splice(seatIndex, 1);
    if (wasActive) table.activeSeatId = null;
    this.#appendEvent(table, "seat_left", seat, text);
    if (wasActive) this.#activateNextSeat(table, seatIndex - 1);
    table.version += 1;
    this.#flushWaiters(table);
  }

  #leaveResult(table: Table, seat: Seat): AgentLeaveResult {
    return {
      left: true,
      table_id: table.id,
      join_code: table.joinCode,
      seat_id: seat.id,
      agent_name: seat.name,
    };
  }

  #rememberDepartedToken(token: string, result: AgentLeaveResult): void {
    this.#departedAgentTokens.set(token, structuredClone(result));
    while (this.#departedAgentTokens.size > LEAVE_RECEIPT_CAP) {
      const oldest = this.#departedAgentTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#departedAgentTokens.delete(oldest);
    }
  }

  #activateNextSeat(table: Table, currentIndex: number): void {
    for (let index = currentIndex + 1; index < table.seats.length; index += 1) {
      const seat = table.seats[index]!;
      if (seat.status !== "waiting") continue;
      seat.status = "active";
      table.activeSeatId = seat.id;
      this.#appendEvent(table, "turn_started", seat, `輪到 ${seat.name}。`);
      return;
    }
    this.#settleRound(table);
  }

  #settleRound(table: Table): void {
    table.activeSeatId = null;
    table.holeRevealed = true;
    if (table.seats.some((seat) => classifyHand(table.mode, seat.cards).kind !== "bust")) {
      while (this.#shouldDealerDraw(table)) table.dealerCards.push(this.#draw(table));
    }
    for (const seat of table.seats) {
      const result = compareHands(table.mode, seat.cards, table.dealerCards);
      seat.result = {
        outcome: result.outcome,
        special: result.special,
        player_points: result.player.score.total,
        dealer_points: result.dealer.score.total,
      };
      seat.records[result.outcome] += 1;
    }
    table.phase = "ended";
    this.#appendEvent(table, "round_ended", null, `第 ${table.round} 局結束。`);
  }

  #shouldDealerDraw(table: Table): boolean {
    const hand = classifyHand(table.mode, table.dealerCards);
    return hand.kind === "points" && hand.score.total < RULES[table.mode].dealerStand;
  }

  #draw(table: Table): Card {
    const card = table.deck.shift();
    if (!card) throw new Error("牌堆已空，無法繼續這局。");
    return card;
  }

  #view(table: Table, viewerSeatId: string): PublicTableView {
    const dealerCards = table.holeRevealed
      ? table.dealerCards.slice()
      : table.mode === "blackjack"
        ? table.dealerCards.slice(0, 1)
        : [];
    const viewer = this.#requireSeat(table, viewerSeatId);
    const legalActions: PublicAction[] = [];
    if (table.phase === "player_turns" && table.activeSeatId === viewer.id) legalActions.push("hit", "stand");
    if (viewer.kind === "human" && (table.phase === "lobby" || table.phase === "ended")) legalActions.push("start_round");
    return {
      table_id: table.id,
      join_code: table.joinCode,
      mode: table.mode,
      rule_label: RULES[table.mode].label,
      phase: table.phase,
      version: table.version,
      round: table.round,
      viewer_seat_id: viewerSeatId,
      active_seat_id: table.activeSeatId,
      players: table.seats.map((seat) => ({
        seat_id: seat.id,
        name: seat.name,
        kind: seat.kind,
        cards: seat.cards.map((card) => card.code),
        points: scoreHand(table.mode, seat.cards).total,
        status: seat.status,
        is_you: seat.id === viewerSeatId,
        result: seat.result ? { ...seat.result } : null,
        records: { ...seat.records },
      })),
      dealer: {
        cards: dealerCards.map((card) => card.code),
        points: dealerCards.length ? scoreHand(table.mode, dealerCards).total : null,
        hole_revealed: table.holeRevealed,
      },
      legal_actions: legalActions,
      recent_chat: table.chat.slice(-20).map((message) => ({ ...message })),
      last_event_id: table.nextEventId - 1,
    };
  }

  #appendEvent(table: Table, kind: TableEventKind, seat: Seat | null, text: string): TableEvent {
    const event: TableEvent = {
      event_id: table.nextEventId,
      kind,
      round: table.round,
      actor_seat_id: seat?.id ?? null,
      actor_name: seat?.name ?? null,
      text,
      at: new Date().toISOString(),
    };
    table.nextEventId += 1;
    table.events.push(event);
    if (table.events.length > EVENT_CAP) table.events.splice(0, table.events.length - EVENT_CAP);
    return event;
  }

  #flushWaiters(table: Table): void {
    for (const [token, waiter] of table.waiters) {
      const session = table.agentSessions.get(token);
      if (!session) continue;
      const unread = this.#consumeUnreadEvents(table, session);
      if (!unread.length) continue;
      clearTimeout(waiter.timer);
      table.waiters.delete(token);
      waiter.resolve(this.#eventResult(table, session, unread, false));
    }
  }

  #consumeUnreadEvents(table: Table, session: AgentSession): TableEvent[] {
    const unread = table.events.filter((event) => event.event_id > session.cursor);
    if (unread.length) session.cursor = unread.at(-1)!.event_id;
    return unread.filter((event) => event.actor_seat_id !== session.seatId).map((event) => ({ ...event }));
  }

  #eventResult(table: Table, session: AgentSession, events: TableEvent[], timedOut: boolean): AgentEventResult {
    return { timed_out: timedOut, events, table: this.#view(table, session.seatId) };
  }

  #tableForHuman(token: string): Table {
    const tableId = this.#humanTokens.get(capabilityHash(token));
    if (!tableId) throw new Error("人類座位憑證無效。");
    return this.#requireTable(tableId);
  }

  #tableForAgent(token: string): { table: Table; session: AgentSession } {
    const tokenHash = capabilityHash(token);
    const tableId = this.#agentTokens.get(tokenHash);
    if (!tableId) throw new Error("Agent 座位憑證無效，請重新加入牌桌。");
    const table = this.#requireTable(tableId);
    const session = table.agentSessions.get(tokenHash);
    if (!session) throw new Error("Agent 座位已失效。");
    return { table, session };
  }

  #requireTable(tableId: string): Table {
    const table = this.#tables.get(tableId);
    if (!table) throw new Error("找不到這張牌桌；牌桌可能已失效或未從持久化狀態恢復。");
    return table;
  }

  #tableForJoinCode(joinCode: string): Table {
    const tableId = this.#joinCodes.get(joinCode.trim().toUpperCase());
    if (!tableId) throw new Error("找不到這組邀請碼。");
    return this.#requireTable(tableId);
  }

  #requireSeat(table: Table, seatId: string): Seat {
    const seat = table.seats.find((candidate) => candidate.id === seatId);
    if (!seat) throw new Error("找不到這個座位。");
    return seat;
  }

  #assertVersion(table: Table, expectedVersion: number): void {
    if (table.version !== expectedVersion) {
      throw new Error(`牌桌版本衝突：目前是 ${table.version}，不是 ${expectedVersion}。請重新讀取牌桌。`);
    }
  }

  #receiptKey(actorId: string, idempotencyKey: string): string {
    return `${actorId}:${idempotencyKey}`;
  }

  #replay<T>(table: Table, actorId: string, idempotencyKey: string, operation: string): T | null {
    const receipt = table.receipts.get(this.#receiptKey(actorId, idempotencyKey));
    if (!receipt) return null;
    if (receipt.operation !== operation) throw new Error("同一個 idempotency_key 已用於不同操作。");
    return structuredClone(receipt.value) as T;
  }

  #remember<T>(table: Table, actorId: string, idempotencyKey: string, operation: string, value: T): T {
    table.receipts.set(this.#receiptKey(actorId, idempotencyKey), { operation, value: structuredClone(value) });
    return value;
  }

  #newJoinCode(): string {
    for (;;) {
      const code = randomBytes(5).toString("base64url").slice(0, 7).toUpperCase();
      if (!this.#joinCodes.has(code)) return code;
    }
  }

  #persist(): void {
    this.#persistence?.save({
      format: "cartes-multiplayer-store",
      version: 1,
      tables: [...this.#tables.values()].map((table) => ({
        id: table.id,
        joinCode: table.joinCode,
        humanTokenHash: table.humanTokenHash,
        mode: table.mode,
        phase: table.phase,
        version: table.version,
        round: table.round,
        deck: table.deck.map((card) => card.code),
        dealerCards: table.dealerCards.map((card) => card.code),
        holeRevealed: table.holeRevealed,
        activeSeatId: table.activeSeatId,
        seats: table.seats.map((seat) => ({
          id: seat.id,
          kind: seat.kind,
          name: seat.name,
          cards: seat.cards.map((card) => card.code),
          status: seat.status,
          result: seat.result,
          records: seat.records,
          principalId: seat.principalId,
        })),
        agentSessions: [...table.agentSessions.values()].map((session) => ({ ...session })),
        events: table.events,
        chat: table.chat,
        nextEventId: table.nextEventId,
        receipts: [...table.receipts.entries()],
        reconnectTickets: [...table.reconnectTickets.entries()],
      })),
      departedAgentTokens: [...this.#departedAgentTokens.entries()],
    });
  }

  #restore(value: unknown): void {
    const snapshot = value as {
      format?: unknown;
      version?: unknown;
      tables?: unknown[];
      departedAgentTokens?: [string, AgentLeaveResult][];
    };
    if (snapshot.format !== "cartes-multiplayer-store" || snapshot.version !== 1 || !Array.isArray(snapshot.tables)) {
      throw new Error("Cartes 持久化檔案格式無效或版本不支援。");
    }
    for (const raw of snapshot.tables) {
      const saved = raw as Record<string, unknown>;
      if (typeof saved.id !== "string" || typeof saved.joinCode !== "string" || typeof saved.humanTokenHash !== "string") {
        throw new Error("Cartes 持久化牌桌資料不完整。");
      }
      if (!Array.isArray(saved.seats) || !Array.isArray(saved.agentSessions)) {
        throw new Error("Cartes 持久化座位資料不完整。");
      }
      const seats = (saved.seats as Array<Record<string, unknown>>).map((seat) => ({
        id: String(seat.id),
        kind: seat.kind as SeatKind,
        name: String(seat.name),
        cards: (seat.cards as string[]).map(parseCard),
        status: seat.status as SeatStatus,
        result: (seat.result ?? null) as SeatResult | null,
        records: seat.records as Seat["records"],
        principalId: typeof seat.principalId === "string" ? seat.principalId : null,
      }));
      const table: Table = {
        id: saved.id,
        joinCode: saved.joinCode,
        humanTokenHash: saved.humanTokenHash,
        mode: saved.mode as GameMode,
        phase: saved.phase as TablePhase,
        version: Number(saved.version),
        round: Number(saved.round),
        deck: (saved.deck as string[]).map(parseCard),
        dealerCards: (saved.dealerCards as string[]).map(parseCard),
        holeRevealed: Boolean(saved.holeRevealed),
        activeSeatId: typeof saved.activeSeatId === "string" ? saved.activeSeatId : null,
        seats,
        agentSessions: new Map(
          (saved.agentSessions as AgentSession[]).map((session) => [session.tokenHash, { ...session }]),
        ),
        events: structuredClone((saved.events ?? []) as TableEvent[]),
        chat: structuredClone((saved.chat ?? []) as PublicChatMessage[]),
        nextEventId: Number(saved.nextEventId),
        receipts: new Map(structuredClone((saved.receipts ?? []) as [string, Receipt<unknown>][])),
        waiters: new Map(),
        reconnectTickets: new Map(
          ((saved.reconnectTickets ?? []) as [string, ReconnectTicket][]).filter(
            ([, ticket]) => ticket.expiresAtMs > Date.now(),
          ),
        ),
      };
      this.#tables.set(table.id, table);
      this.#joinCodes.set(table.joinCode, table.id);
      this.#humanTokens.set(table.humanTokenHash, table.id);
      for (const [tokenHash] of table.agentSessions) this.#agentTokens.set(tokenHash, table.id);
      for (const seat of table.seats) {
        if (seat.principalId) this.#principalSeats.set(seat.principalId, { tableId: table.id, seatId: seat.id });
      }
    }
    for (const [tokenHash, departure] of snapshot.departedAgentTokens ?? []) {
      this.#departedAgentTokens.set(tokenHash, structuredClone(departure));
    }
  }
}

function capabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function capabilityHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizePrincipal(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new Error("遠端 MCP 身分無效。");
  return normalized;
}

function normalizeName(value: string, fallback: string): string {
  const normalized = value.trim().slice(0, 80);
  return normalized || fallback;
}
