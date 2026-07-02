/**
 * Game 29 — Server-Authoritative Multiplayer Backend (Module)
 * =====================================================
 * সমস্ত গেম লজিক এখন সার্ভারে।
 * Flutter client শুধু action পাঠাবে এবং UI আপডেট করবে।
 */

'use strict';

const express  = require('express');
const { WebSocket } = require('ws');
const crypto   = require('crypto');

const router = express.Router();

// ============================================================
// CARD CONSTANTS
// ============================================================
const SUITS  = ['s', 'd', 'c', 'h'];
const RANKS  = ['j', '9', 'a', '10', 'k', 'q', '8', '7'];
const RANK_VALUES = { j:3, '9':2, a:1, '10':1, k:0, q:0, '8':0, '7':0 };
const RANK_POWER  = { j:8, '9':7, a:6, '10':5, k:4, q:3, '8':2, '7':1 };

// ============================================================
// IN-MEMORY STATE
// ============================================================
const rooms = new Map();
const connections = new Map();
const playerConnections = new Map();

// ============================================================
// GAME STATE FACTORY
// ============================================================
function newGameState(roundStarterIndex = 1) {
  return {
    deck: [],
    hands: [[], [], [], []],

    roundStarterIndex,
    handsPlayed: 0,
    currentTrick: [],
    leadSuit: null,

    trumpSuit: null,
    isTrumpRevealed: false,
    currentTrickTrumpRevealer: null,

    isBiddingPhase: true,
    isWaitingForTrump: false,
    isTrickEvaluating: false,
    currentBid: 15,
    highestBidder: -1,
    bidder: -1,
    defenderIdx: roundStarterIndex,
    challengerIdx: (roundStarterIndex + 1) % 4,
    currentBidderIdx: roundStarterIndex,
    passedPlayers: [false, false, false, false],
    pairShown: [false, false, false, false],
    turnIndex: 0,

    isDoublePhase: false,
    isRedoublePhase: false,
    isDoubled: false,
    isRedoubled: false,
    gamePointMultiplier: 1,
    doublePasses: [false, false, false, false],
    redoublePasses: [false, false, false, false],

    isSingleHandPhase: false,
    singleHandDeclarer: -1,
    sittingOutPlayer: -1,
    singleHandPasses: [false, false, false, false],

    teamScores: [0, 0],
    gamePoints: [0, 0],
  };
}

// ============================================================
// UTILITY — ROOM & WEBSOCKET
// ============================================================
function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getSlotAssignments(room) {
  const slots = ['BOT', 'BOT', 'BOT', 'BOT'];
  Object.entries(room.players).forEach(([pid, p]) => {
    if (p.slot >= 0 && p.slot < 4) slots[p.slot] = p.isBot ? 'BOT' : pid;
  });
  return slots;
}

function findFirstEmptySlot(players) {
  const occupied = Object.values(players).map(p => p.slot);
  for (let i = 0; i < 4; i++) if (!occupied.includes(i)) return i;
  return -1;
}

function sendToSocket(socketId, payload) {
  const conn = connections.get(socketId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(payload));
  }
}

function sendToPlayer(playerId, payload) {
  const sid = playerConnections.get(playerId);
  if (sid) sendToSocket(sid, payload);
}

function broadcastToRoom(roomCode, payload, excludePlayerId = null) {
  const raw = JSON.stringify(payload);
  connections.forEach((conn) => {
    if (conn.roomCode === roomCode && conn.playerId !== excludePlayerId) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(raw);
    }
  });
}

function broadcastRoomUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  broadcastToRoom(roomCode, {
    type: 'ROOM_UPDATE',
    roomCode,
    room: {
      hostId: room.hostId, hostName: room.hostName,
      status: room.status, type: room.type,
      allowAudience: room.allowAudience, sessionId: room.sessionId,
      players: room.players, requests: room.requests, audiences: room.audiences,
    },
  });
}

function gameEvent(roomCode, event, payload, targetPlayerId = null) {
  const msg = { type: 'GAME_EVENT', event, payload: payload || {} };
  if (targetPlayerId) sendToPlayer(targetPlayerId, msg);
  else broadcastToRoom(roomCode, msg);
}

// ============================================================
// CARD HELPERS
// ============================================================
function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${s}_${r}`);
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function cardSuit(code) { return code.split('_')[0]; }
function cardRank(code) { return code.split('_')[1]; }
function cardValue(code) { return RANK_VALUES[cardRank(code)] ?? 0; }
function cardPower(code) { return RANK_POWER[cardRank(code)] ?? 0; }

// ============================================================
// GAME LOGIC
// ============================================================
function startNewRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const gs = newGameState(room.game ? room.game.roundStarterIndex : 1);
  room.game = gs;
  room.status = 'PLAYING';

  gs.deck = buildDeck();
  shuffleDeck(gs.deck);

  for (let i = 0; i < 4; i++) {
    gs.hands[i] = [];
    for (let j = 0; j < 4; j++) gs.hands[i].push(gs.deck.shift());
  }

  const firstBidderPoints = gs.hands[gs.roundStarterIndex].reduce((s, c) => s + cardValue(c), 0);
  let anyoneHas4Jacks = false;
  for (let i = 0; i < 4; i++) {
    if (gs.hands[i].filter(c => cardRank(c) === 'j').length === 4) { anyoneHas4Jacks = true; break; }
  }

  if (firstBidderPoints === 0 || anyoneHas4Jacks) {
    broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'REDEAL', payload: {} });
    setTimeout(() => startNewRound(roomCode), 1500);
    return;
  }

  gameEvent(roomCode, 'ROUND_START', { roundStarterIndex: gs.roundStarterIndex });

  const slots = getSlotAssignments(room);
  
  broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'DEAL_4_INFO', payload: { roundStarterIndex: gs.roundStarterIndex } });

  setTimeout(() => {
    for (let i = 0; i < 4; i++) {
      const pid = slots[i];
      if (pid !== 'BOT') {
        gameEvent(roomCode, 'DEAL_4', {
          cards: gs.hands[i].slice(0, 4).join(','),
          slot: i,
          roundStarterIndex: gs.roundStarterIndex,
        }, pid);
      }
    }

    setTimeout(() => {
      gs.currentBid = 15;
      gs.highestBidder = -1;
      gs.passedPlayers = [false, false, false, false];
      gs.defenderIdx = gs.roundStarterIndex;
      gs.challengerIdx = getNextUnpassed(gs, gs.roundStarterIndex, gs.roundStarterIndex);
      gs.currentBidderIdx = gs.roundStarterIndex;
      processBidTurn(roomCode);
    }, 2000);
  }, 300);
}

// ── BIDDING ─────────────────────────────────────────────────
function getNextUnpassed(gs, startIdx, ignoreIdx) {
  for (let i = 1; i < 4; i++) {
    const check = (startIdx + i) % 4;
    if (!gs.passedPlayers[check] && check !== ignoreIdx) return check;
  }
  return -1;
}

function processBidTurn(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase) return;

  const passedCount = gs.passedPlayers.filter(Boolean).length;

  if (passedCount === 4) {
    gs.isBiddingPhase = false;
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    gameEvent(roomCode, 'REDEAL', {});
    setTimeout(() => startNewRound(roomCode), 1500);
    return;
  }

  if (passedCount >= 3 && gs.highestBidder !== -1) {
    gs.isBiddingPhase = false;
    gs.isWaitingForTrump = true;
    gs.bidder = gs.highestBidder;
    gameEvent(roomCode, 'BID_WINNER', { bidder: gs.bidder, currentBid: gs.currentBid });

    const slots = getSlotAssignments(room);
    if (slots[gs.bidder] === 'BOT') {
      setTimeout(() => botChooseTrump(roomCode, gs.bidder), 800);
    } else {
      gameEvent(roomCode, 'TRUMP_REQ', {}, slots[gs.bidder]);
    }
    return;
  }

  const slots = getSlotAssignments(room);
  const pid = slots[gs.currentBidderIdx];
  if (pid === 'BOT') {
    setTimeout(() => botBid(roomCode, gs.currentBidderIdx), 1000);
  } else {
    gameEvent(roomCode, 'BID_REQ', {
      defenderIdx: gs.defenderIdx,
      challengerIdx: gs.challengerIdx,
      currentBid: gs.currentBid,
      currentBidderIdx: gs.currentBidderIdx,
    }, pid);
  }
}

function applyBid(roomCode, senderIdx, bid) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== senderIdx) return;

  const isFirstBid = (gs.highestBidder === -1);
  gs.highestBidder = senderIdx;
  gs.currentBid = bid;

  if (isFirstBid) {
    gs.defenderIdx = senderIdx;
    gs.challengerIdx = getNextUnpassed(gs, senderIdx, senderIdx);
    gs.currentBidderIdx = gs.challengerIdx;
  } else {
    gs.currentBidderIdx = (gs.currentBidderIdx === gs.defenderIdx) ? gs.challengerIdx : gs.defenderIdx;
  }

  gameEvent(roomCode, 'BID_INFO', { bid, senderIdx });
  processBidTurn(roomCode);
}

function applyBidPass(roomCode, senderIdx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== senderIdx) return;

  gs.passedPlayers[senderIdx] = true;

  if (gs.highestBidder === -1) {
    gs.currentBidderIdx = getNextUnpassed(gs, gs.currentBidderIdx, -1);
  } else {
    if (senderIdx === gs.defenderIdx) {
      gs.defenderIdx = gs.challengerIdx;
      gs.challengerIdx = getNextUnpassed(gs, gs.defenderIdx, gs.defenderIdx);
      gs.currentBidderIdx = gs.challengerIdx;
    } else if (senderIdx === gs.challengerIdx) {
      gs.challengerIdx = getNextUnpassed(gs, gs.challengerIdx, gs.defenderIdx);
      gs.currentBidderIdx = gs.challengerIdx;
    }
  }

  gameEvent(roomCode, 'BID_PASS_INFO', { senderIdx });
  processBidTurn(roomCode);
}

function botBid(roomCode, idx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== idx) return;

  const hand = gs.hands[idx];
  const jCount = hand.filter(c => cardRank(c) === 'j').length;
  const nineCount = hand.filter(c => cardRank(c) === '9').length;
  const totalValue = hand.reduce((s, c) => s + cardValue(c), 0);
  
  let hasMarriage = false;
  for (const s of SUITS) {
    const hasK = hand.some(c => cardSuit(c) === s && cardRank(c) === 'k');
    const hasQ = hand.some(c => cardSuit(c) === s && cardRank(c) === 'q');
    if (hasK && hasQ) hasMarriage = true;
  }

  let maxBotBid = 0;
  if (jCount >= 2 && totalValue >= 9) maxBotBid = hasMarriage ? 24 : 22;
  else if (jCount >= 2) maxBotBid = hasMarriage ? 22 : 19;
  else if (jCount === 1 && nineCount >= 1 && totalValue >= 7) maxBotBid = hasMarriage ? 20 : 18;
  else if (jCount === 1 && totalValue >= 5) maxBotBid = 17;
  else if (nineCount >= 2 && totalValue >= 6) maxBotBid = 16;
  else if (totalValue >= 7) maxBotBid = 16;

  const isFirstBid = (gs.highestBidder === -1);
  const canMatch = (!isFirstBid && idx === gs.defenderIdx);

  let willBid = false;
  if (canMatch) {
    if (maxBotBid >= gs.currentBid && gs.currentBid < 28) willBid = true;
  } else {
    const bidToMake = isFirstBid ? 16 : gs.currentBid + 1;
    if (maxBotBid >= bidToMake && bidToMake <= 28) {
      gs.currentBid = bidToMake;
      willBid = true;
    }
  }

  if (willBid) {
    applyBid(roomCode, idx, gs.currentBid);
  } else {
    applyBidPass(roomCode, idx);
  }
}

// ── TRUMP ────────────────────────────────────────────────────
function applyTrumpSelect(roomCode, senderIdx, suit) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isWaitingForTrump || gs.bidder !== senderIdx) return;

  gs.isWaitingForTrump = false;
  gs.trumpSuit = suit;
  gs.isTrumpRevealed = false;
  gameEvent(roomCode, 'TRUMP_SET', { suit: 'HIDDEN' });
  finishDealing(roomCode);
}

function botChooseTrump(roomCode, idx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isWaitingForTrump) return;

  const hand = gs.hands[idx];
  const suitScores = { s: 0, d: 0, c: 0, h: 0 };
  
  for (const c of hand) {
    const s = cardSuit(c);
    suitScores[s] += cardPower(c); 
  }
  
  const best = Object.entries(suitScores).sort((a, b) => b[1] - a[1])[0];
  gs.isWaitingForTrump = false;
  gs.trumpSuit = best ? best[0] : SUITS[0];
  gs.isTrumpRevealed = false;
  gameEvent(roomCode, 'TRUMP_SET', { suit: 'HIDDEN' });
  finishDealing(roomCode);
}

function finishDealing(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (gs.deck.length > 0) gs.hands[i].push(gs.deck.shift());
    }
  }

  const slots = getSlotAssignments(room);
  
  broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'DEAL_REST_INFO', payload: {} });

  for (let i = 0; i < 4; i++) {
    const pid = slots[i];
    if (pid !== 'BOT') {
      gameEvent(roomCode, 'DEAL_REST', {
        cards: gs.hands[i].slice(4, 8).join(','),
        slot: i,
      }, pid);
    }
  }

  gs.turnIndex = gs.roundStarterIndex;
  setTimeout(() => startDoublePhase(roomCode), 1000);
}

// ── REVEAL TRUMP ─────────────────────────────────────────────
function applyRevealTrump(roomCode, senderIdx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isTrumpRevealed || !gs.trumpSuit) return;

  gs.isTrumpRevealed = true;
  gs.currentTrickTrumpRevealer = senderIdx;
  gameEvent(roomCode, 'TRUMP_REVEAL', { suit: gs.trumpSuit, revealerIdx: senderIdx });
}

// ── SHOW PAIR ────────────────────────────────────────────────
function applyShowPair(roomCode, senderIdx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.pairShown[senderIdx]) return;

  const hand = gs.hands[senderIdx];
  const hasK = hand.some(c => cardSuit(c) === gs.trumpSuit && cardRank(c) === 'k');
  const hasQ = hand.some(c => cardSuit(c) === gs.trumpSuit && cardRank(c) === 'q');
  if (!hasK || !hasQ || !gs.isTrumpRevealed || gs.currentBid < 16) return;

  gs.pairShown[senderIdx] = true;
  const isBidderTeam = (gs.bidder % 2 === senderIdx % 2);
  if (isBidderTeam) gs.currentBid = Math.max(16, gs.currentBid - 4);
  else gs.currentBid = Math.min(28, gs.currentBid + 4);

  gameEvent(roomCode, 'PAIR_SHOWN', { senderIdx, currentBid: gs.currentBid });
}

// ── DOUBLE/REDOUBLE/SINGLE HAND ──────────────────────────────
function startDoublePhase(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isDoublePhase = true;
  gs.doublePasses = [false, false, false, false];
  gameEvent(roomCode, 'DOUBLE_PHASE_START', {});

  const slots = getSlotAssignments(room);
  const opp1 = (gs.bidder + 1) % 4;
  const opp2 = (gs.bidder + 3) % 4;

  if (slots[opp1] === 'BOT') gs.doublePasses[opp1] = true;
  else gameEvent(roomCode, 'REQ_DOUBLE', {}, slots[opp1]);

  if (slots[opp2] === 'BOT') gs.doublePasses[opp2] = true;
  else gameEvent(roomCode, 'REQ_DOUBLE', {}, slots[opp2]);

  if (gs.doublePasses[opp1] && gs.doublePasses[opp2]) {
    gs.isDoublePhase = false;
    setTimeout(() => finishDoublePhase(roomCode), 300);
  }
}

function applyDoubleAction(roomCode, senderIdx, choice) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isDoublePhase) return;

  const opp1 = (gs.bidder + 1) % 4;
  const opp2 = (gs.bidder + 3) % 4;

  if (choice === 'DOUBLE') {
    gs.isDoublePhase = false;
    gs.isDoubled = true;
    gs.gamePointMultiplier = 2;
    gameEvent(roomCode, 'DOUBLE_MADE_INFO', { senderIdx });
    setTimeout(() => startRedoublePhase(roomCode), 300);
  } else {
    gs.doublePasses[senderIdx] = true;
    if (gs.doublePasses[opp1] && gs.doublePasses[opp2]) {
      gs.isDoublePhase = false;
      setTimeout(() => finishDoublePhase(roomCode), 300);
    }
  }
}

function startRedoublePhase(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isRedoublePhase = true;
  gs.redoublePasses = [false, false, false, false];
  gameEvent(roomCode, 'REDOUBLE_PHASE_START', {});

  const slots = getSlotAssignments(room);
  const bid1 = gs.bidder;
  const bid2 = (gs.bidder + 2) % 4;

  if (slots[bid1] === 'BOT') gs.redoublePasses[bid1] = true;
  else gameEvent(roomCode, 'REQ_REDOUBLE', {}, slots[bid1]);

  if (slots[bid2] === 'BOT') gs.redoublePasses[bid2] = true;
  else gameEvent(roomCode, 'REQ_REDOUBLE', {}, slots[bid2]);

  if (gs.redoublePasses[bid1] && gs.redoublePasses[bid2]) {
    gs.isRedoublePhase = false;
    setTimeout(() => finishDoublePhase(roomCode), 300);
  }
}

function applyRedoubleAction(roomCode, senderIdx, choice) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isRedoublePhase) return;

  const bid1 = gs.bidder;
  const bid2 = (gs.bidder + 2) % 4;

  if (choice === 'REDOUBLE') {
    gs.isRedoublePhase = false;
    gs.isRedoubled = true;
    gs.gamePointMultiplier = 4;
    gameEvent(roomCode, 'REDOUBLE_MADE_INFO', { senderIdx });
    setTimeout(() => finishDoublePhase(roomCode), 300);
  } else {
    gs.redoublePasses[senderIdx] = true;
    if (gs.redoublePasses[bid1] && gs.redoublePasses[bid2]) {
      gs.isRedoublePhase = false;
      setTimeout(() => finishDoublePhase(roomCode), 300);
    }
  }
}

function finishDoublePhase(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  gs.isDoublePhase = false;
  gs.isRedoublePhase = false;
  startSingleHandPhase(roomCode);
}

function startSingleHandPhase(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isSingleHandPhase = true;
  gs.singleHandPasses = [false, false, false, false];
  gameEvent(roomCode, 'SINGLE_HAND_PHASE_START', {});

  const slots = getSlotAssignments(room);
  for (let i = 0; i < 4; i++) {
    if (slots[i] === 'BOT') gs.singleHandPasses[i] = true;
    else gameEvent(roomCode, 'REQ_SINGLE_HAND', {}, slots[i]);
  }

  if (gs.singleHandPasses.filter(Boolean).length === 4) {
    gs.isSingleHandPhase = false;
    setTimeout(() => playTurn(roomCode), 300);
  }
}

function applySingleHandAction(roomCode, senderIdx, choice) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isSingleHandPhase) return;

  if (choice === 'DECLARE') {
    gs.isSingleHandPhase = false;
    gs.singleHandDeclarer = senderIdx;
    gs.sittingOutPlayer = (senderIdx + 2) % 4;
    gameEvent(roomCode, 'SINGLE_HAND_MADE_INFO', { senderIdx });
    setTimeout(() => playTurn(roomCode), 300);
  } else {
    gs.singleHandPasses[senderIdx] = true;
    if (gs.singleHandPasses.filter(Boolean).length === 4) {
      gs.isSingleHandPhase = false;
      setTimeout(() => playTurn(roomCode), 300);
    }
  }
}

// ── PLAY TURN ────────────────────────────────────────────────
function playTurn(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (gs.turnIndex === gs.sittingOutPlayer) {
    gs.turnIndex = (gs.turnIndex + 1) % 4;
  }

  gameEvent(roomCode, 'TURN', { turnIndex: gs.turnIndex });

  const slots = getSlotAssignments(room);
  if (slots[gs.turnIndex] === 'BOT') {
    setTimeout(() => botPlay(roomCode, gs.turnIndex), 1000);
  }
}

function applyMove(roomCode, senderIdx, card) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isBiddingPhase || gs.isTrickEvaluating || gs.turnIndex !== senderIdx) return;

  const hand = gs.hands[senderIdx];
  if (!hand.includes(card)) return;

  if (gs.leadSuit) {
    const hasLead = hand.some(c => cardSuit(c) === gs.leadSuit);
    if (hasLead && cardSuit(card) !== gs.leadSuit) return;
    if (!hasLead && gs.currentTrickTrumpRevealer === senderIdx && gs.trumpSuit) {
      const hasTrump = hand.some(c => cardSuit(c) === gs.trumpSuit);
      if (hasTrump && cardSuit(card) !== gs.trumpSuit) return;
    }
  }

  if (!gs.isTrumpRevealed && gs.leadSuit && cardSuit(card) === gs.trumpSuit &&
      !hand.some(c => cardSuit(c) === gs.leadSuit)) {
    gs.isTrumpRevealed = true;
    gs.currentTrickTrumpRevealer = senderIdx;
    gameEvent(roomCode, 'TRUMP_REVEAL', { suit: gs.trumpSuit, revealerIdx: senderIdx });
  }

  gs.hands[senderIdx] = hand.filter(c => c !== card);

  if (gs.currentTrick.length === 0) gs.leadSuit = cardSuit(card);
  gs.currentTrick.push({ playerIndex: senderIdx, card });

  checkAndShowPairAuto(roomCode, senderIdx);

  gameEvent(roomCode, 'MOVE_UI', { playerIndex: senderIdx, card });

  const trickSize = gs.singleHandDeclarer !== -1 ? 3 : 4;
  if (gs.currentTrick.length === trickSize) {
    gs.isTrickEvaluating = true;
    setTimeout(() => evaluateTrick(roomCode), 800);
  } else {
    gs.turnIndex = (gs.turnIndex + 1) % 4;
    if (gs.turnIndex === gs.sittingOutPlayer) gs.turnIndex = (gs.turnIndex + 1) % 4;
    setTimeout(() => playTurn(roomCode), 300);
  }
}

function checkAndShowPairAuto(roomCode, idx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.pairShown[idx] || !gs.isTrumpRevealed || gs.currentBid < 16) return;

  const hand = gs.hands[idx];
  const hasK = hand.some(c => cardSuit(c) === gs.trumpSuit && cardRank(c) === 'k');
  const hasQ = hand.some(c => cardSuit(c) === gs.trumpSuit && cardRank(c) === 'q');
  if (hasK && hasQ) {
    const slots = getSlotAssignments(room);
    if (slots[idx] === 'BOT') applyShowPair(roomCode, idx);
  }
}

function botPlay(roomCode, idx) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isTrickEvaluating || gs.turnIndex !== idx) return;

  const hand = gs.hands[idx];
  if (!hand.length) return;

  checkAndShowPairAuto(roomCode, idx);

  let card;
  if (gs.currentTrick.length === 0) {
    card = hand.reduce((a, b) => cardPower(a) > cardPower(b) ? a : b);
  } else {
    const lead = gs.leadSuit;
    const followSuit = hand.filter(c => cardSuit(c) === lead);

    let winningIdx = gs.currentTrick[0].playerIndex;
    let bestPower = cardPower(gs.currentTrick[0].card);
    let bestIsTrump = gs.isTrumpRevealed && cardSuit(gs.currentTrick[0].card) === gs.trumpSuit;

    for (const pc of gs.currentTrick) {
      const isTrump = gs.isTrumpRevealed && cardSuit(pc.card) === gs.trumpSuit;
      if (isTrump && !bestIsTrump) {
        winningIdx = pc.playerIndex; bestPower = cardPower(pc.card); bestIsTrump = true;
      } else if (isTrump === bestIsTrump && cardSuit(pc.card) === cardSuit(gs.currentTrick[0].card)) {
        if (cardPower(pc.card) > bestPower) {
          winningIdx = pc.playerIndex; bestPower = cardPower(pc.card);
        }
      }
    }

    const isPartnerWinning = (winningIdx % 2 === idx % 2);

    if (followSuit.length) {
      if (isPartnerWinning) {
        card = followSuit.reduce((a, b) => cardValue(a) > cardValue(b) ? a : b);
      } else {
        card = followSuit.reduce((a, b) => cardPower(a) > cardPower(b) ? a : b);
      }
    } else {
      const trumpCards = hand.filter(c => cardSuit(c) === gs.trumpSuit);
      if (trumpCards.length && !isPartnerWinning) {
        card = trumpCards.reduce((a, b) => cardPower(a) < cardPower(b) ? a : b);
      } else {
        card = hand.reduce((a, b) => (cardValue(a) + cardPower(a)) < (cardValue(b) + cardPower(b)) ? a : b);
      }
    }
  }

  applyMove(roomCode, idx, card);
}

// ── EVALUATE TRICK ───────────────────────────────────────────
function evaluateTrick(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  const trick = gs.currentTrick;
  const limit = gs.singleHandDeclarer !== -1 ? 3 : 4;
  const trickLead = cardSuit(trick[0].card);

  const revealTrickIndex = gs.currentTrickTrumpRevealer !== null
    ? trick.findIndex(pc => pc.playerIndex === gs.currentTrickTrumpRevealer)
    : -1;

  function isValidTrump(i) {
    if (!gs.isTrumpRevealed || cardSuit(trick[i].card) !== gs.trumpSuit) return false;
    if (revealTrickIndex === -1) return true;
    return i >= revealTrickIndex;
  }

  let winIdx = 0;
  let best = trick[0].card;
  let bestIsTrump = isValidTrump(0);

  for (let i = 1; i < limit; i++) {
    const pc = trick[i].card;
    const pcIsTrump = isValidTrump(i);
    if (pcIsTrump) {
      if (!bestIsTrump) { best = pc; winIdx = i; bestIsTrump = true; }
      else if (cardPower(pc) > cardPower(best)) { best = pc; winIdx = i; }
    } else if (cardSuit(pc) === trickLead) {
      if (!bestIsTrump && cardPower(pc) > cardPower(best)) { best = pc; winIdx = i; }
    }
  }

  const winner = trick[winIdx].playerIndex;
  const pts = trick.reduce((s, pc) => s + cardValue(pc.card), 0);
  const winTeam = winner % 2; 
  gs.teamScores[winTeam] += pts;

  gameEvent(roomCode, 'TRICK_WIN', { winner, pts });

  gs.currentTrick = [];
  gs.leadSuit = null;
  gs.currentTrickTrumpRevealer = null;
  gs.handsPlayed++;
  gs.isTrickEvaluating = false;

  if (gs.handsPlayed === 7 && !gs.isTrumpRevealed) {
    gameEvent(roomCode, 'ROUND_CANCELLED_NO_TRUMP', {});
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    setTimeout(() => startNewRound(roomCode), 3000);
    return;
  }

  if (gs.singleHandDeclarer !== -1 && winner !== gs.singleHandDeclarer) {
    const declTeam = gs.singleHandDeclarer % 2;
    gs.gamePoints[declTeam] -= 6;
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    gameEvent(roomCode, 'ROUND_OVER', {
      gamePointsTeam0: gs.gamePoints[0],
      gamePointsTeam1: gs.gamePoints[1],
      code: 'SingleHandLost',
    });
    room.status = 'WAITING';
    return;
  }

  if (gs.handsPlayed === 8) {
    resolveRound(roomCode);
  } else {
    gs.turnIndex = winner;
    setTimeout(() => playTurn(roomCode), 500);
  }
}

function resolveRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  let code = '';
  if (gs.singleHandDeclarer !== -1) {
    const declTeam = gs.singleHandDeclarer % 2;
    gs.gamePoints[declTeam] += 6;
    code = 'SingleHandWon';
  } else {
    const bidTeam = gs.bidder % 2;
    const bidderScore = gs.teamScores[bidTeam];
    if (bidderScore >= gs.currentBid) {
      gs.gamePoints[bidTeam] += (1 * gs.gamePointMultiplier);
      code = bidTeam === 0 ? 'Won' : 'ThemWon';
    } else {
      gs.gamePoints[bidTeam] -= (1 * gs.gamePointMultiplier);
      code = bidTeam === 0 ? 'Lost' : 'ThemLost';
    }
  }

  gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;

  gameEvent(roomCode, 'ROUND_OVER', {
    gamePointsTeam0: gs.gamePoints[0],
    gamePointsTeam1: gs.gamePoints[1],
    teamScore0: gs.teamScores[0],
    teamScore1: gs.teamScores[1],
    code,
    bidder: gs.bidder,
    currentBid: gs.currentBid,
  });

  const g0 = gs.gamePoints[0], g1 = gs.gamePoints[1];
  if (g0 >= 6 || g1 <= -6 || g1 >= 6 || g0 <= -6) {
    room.status = 'WAITING';
  } else {
    room.status = 'WAITING';
  }
}

// ── AUDIENCE PROMOTE ─────────────────────────────────────────
function applyPromote(roomCode, hostId, audienceId, audienceName, slot) {
  const room = rooms.get(roomCode);
  if (!room || room.hostId !== hostId) return;

  const occupiedByRealPlayer = Object.entries(room.players).some(
    ([pid, p]) => p.slot === slot && !p.isBot
  );
  if (occupiedByRealPlayer) return;

  if (!room.audiences[audienceId]) return;

  Object.keys(room.players).forEach(pid => {
    if (room.players[pid].slot === slot && room.players[pid].isBot) {
      delete room.players[pid];
    }
  });
  delete room.audiences[audienceId];
  room.players[audienceId] = { name: audienceName, slot, isBot: false };

  const sid = playerConnections.get(audienceId);
  if (sid) {
    const conn = connections.get(sid);
    if (conn) conn.isAudience = false;
  }

  broadcastRoomUpdate(roomCode);

  const chatTxt = `${audienceName} replaced Bot in Slot ${slot + 1}`;
  gameEvent(roomCode, 'CHAT', { sender: 'SERVER', message: chatTxt });

  const gs = room.game;
  if (gs) {
    const syncData = {
      slot,
      isAudience: false,
      hand: (gs.hands[slot] || []).join(','),
      turnIndex: gs.turnIndex,
      roundStarterIndex: gs.roundStarterIndex,
      trumpSuit: gs.trumpSuit,
      isTrumpRevealed: gs.isTrumpRevealed,
      currentTrickTrumpRevealer: gs.currentTrickTrumpRevealer,
      leadSuit: gs.leadSuit,
      handsPlayed: gs.handsPlayed,
      isBiddingPhase: gs.isBiddingPhase,
      isWaitingForTrump: gs.isWaitingForTrump,
      currentBid: gs.currentBid,
      bidder: gs.bidder,
      highestBidder: gs.highestBidder,
      currentBidderIdx: gs.currentBidderIdx,
      defenderIdx: gs.defenderIdx,
      challengerIdx: gs.challengerIdx,
      teamScore0: gs.teamScores[0],
      teamScore1: gs.teamScores[1],
      gamePointsTeam0: gs.gamePoints[0],
      gamePointsTeam1: gs.gamePoints[1],
      isDoublePhase: gs.isDoublePhase,
      isRedoublePhase: gs.isRedoublePhase,
      isDoubled: gs.isDoubled,
      isRedoubled: gs.isRedoubled,
      gamePointMultiplier: gs.gamePointMultiplier,
      isSingleHandPhase: gs.isSingleHandPhase,
      singleHandDeclarer: gs.singleHandDeclarer,
      sittingOutPlayer: gs.sittingOutPlayer,
      passedPlayers: gs.passedPlayers,
      pairShown: gs.pairShown,
      currentTrick: gs.currentTrick.map(pc => `${pc.playerIndex}-${pc.card}`).join(','),
      isMyBidTurn: gs.isBiddingPhase && gs.currentBidderIdx === slot,
      isMyTrumpTurn: gs.isWaitingForTrump && gs.bidder === slot,
      isMyPlayTurn: !gs.isBiddingPhase && !gs.isTrickEvaluating && gs.turnIndex === slot,
      isMyDoubleTurn: gs.isDoublePhase && (slot === (gs.bidder + 1) % 4 || slot === (gs.bidder + 3) % 4) && !gs.doublePasses[slot],
      isMyRedoubleTurn: gs.isRedoublePhase && (slot === gs.bidder || slot === (gs.bidder + 2) % 4) && !gs.redoublePasses[slot],
      isMySingleHandTurn: gs.isSingleHandPhase && !gs.singleHandPasses[slot],
    };

    gameEvent(roomCode, 'SYNC_STATE', syncData, audienceId);
  }
}

// ============================================================
// HTTP REST API (Now via router)
// ============================================================
router.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, connections: connections.size, uptime: Math.floor(process.uptime()) });
});

router.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room, code) => {
    if (room.type !== 'public') return;
    const playerCount = Object.keys(room.players).length;
    const canJoin = (room.status === 'WAITING' && (playerCount < 4 || room.allowAudience))
                 || (room.status === 'PLAYING' && room.allowAudience);
    if (canJoin) list.push({ code, hostName: room.hostName, playerCount, allowsAudience: room.allowAudience, status: room.status });
  });
  res.json(list);
});

router.get('/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: req.params.code, hostId: room.hostId, hostName: room.hostName,
    status: room.status, type: room.type, allowAudience: room.allowAudience,
    sessionId: room.sessionId, playerCount: Object.keys(room.players).length,
    players: room.players, requests: room.requests, audiences: room.audiences,
  });
});

router.post('/rooms/create', (req, res) => {
  const { playerId, playerName, type, allowAudience } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  rooms.forEach((r, code) => { if (r.hostId === playerId) rooms.delete(code); });

  const roomCode = generateRoomCode();
  rooms.set(roomCode, {
    hostId: playerId, hostName: playerName,
    status: 'WAITING',
    type: type === 'private' ? 'private' : 'public',
    allowAudience: allowAudience !== false,
    sessionId: null, createdAt: Date.now(),
    players: { [playerId]: { name: playerName, slot: 0, isBot: false } },
    requests: {}, audiences: {},
    game: null,
    disconnectedPlayers: {}, // Track disconnected players for seat recovery
  });
  res.json({ success: true, roomCode });
});

router.post('/rooms/:code/join', (req, res) => {
  const { playerId, playerName, asAudience } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // ── SEAT RECOVERY LOGIC (Seamless Rejoin) ──
  if (room.disconnectedPlayers && room.disconnectedPlayers[playerId]) {
    const oldData = room.disconnectedPlayers[playerId];
    // Give them their seat back if a bot is there
    if (room.players[`BOT_${oldData.slot}`]) {
      delete room.players[`BOT_${oldData.slot}`];
      room.players[playerId] = { name: playerName, slot: oldData.slot, isBot: false };
      delete room.disconnectedPlayers[playerId];
      broadcastRoomUpdate(req.params.code);
      gameEvent(req.params.code, 'CHAT', { sender: 'SERVER', message: `${playerName} rejoined the game and took back their seat.` });
      gameEvent(req.params.code, 'PLAYER_REJOINED', { playerId, slot: oldData.slot, playerName });
      return res.json({ role: 'player', reason: 'rejoined' });
    }
  }

  if (asAudience) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Audience not allowed' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience' });
  }

  if (room.status === 'PLAYING') {
    if (!room.allowAudience) return res.status(403).json({ error: 'Game in progress' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'game_started' });
  }

  if (Object.keys(room.players).length >= 4) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Room full' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'room_full' });
  }

  room.requests[playerId] = { name: playerName };
  broadcastRoomUpdate(req.params.code);
  res.json({ role: 'requested' });
});

router.post('/rooms/:code/admit', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const req2 = room.requests[playerId];
  if (!req2) return res.status(404).json({ error: 'Request not found' });

  const slot = findFirstEmptySlot(room.players);
  if (slot === -1) return res.status(400).json({ error: 'Room full' });

  delete room.requests[playerId];
  room.players[playerId] = { name: req2.name, slot, isBot: false };
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

router.post('/rooms/:code/reject', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  delete room.requests[playerId];
  const sid = playerConnections.get(playerId);
  if (sid) sendToSocket(sid, { type: 'REJECTED' });
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

router.post('/rooms/:code/start', (req, res) => {
  const { hostId, sessionId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  for (let i = 0; i < 4; i++) {
    const occupied = Object.values(room.players).map(p => p.slot);
    if (!occupied.includes(i)) {
      room.players[`BOT_${i}`] = { name: 'Bot', slot: i, isBot: true };
    }
  }

  const sid = sessionId || crypto.randomUUID();
  room.sessionId = sid;
  room.status = 'PLAYING';
  broadcastRoomUpdate(req.params.code);

  room.game = newGameState(1); 
  setTimeout(() => {
    startNewRound(req.params.code);
  }, 2500);

  res.json({ success: true, sessionId: sid });
});

router.delete('/rooms/:code', (req, res) => {
  const { playerId, isHost } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (isHost) {
    broadcastToRoom(req.params.code, { type: 'ROOM_DELETED', reason: 'Host deleted room' });
    rooms.delete(req.params.code);
  } else {
    delete room.players[playerId];
    delete room.audiences[playerId];
    delete room.requests[playerId];
    broadcastRoomUpdate(req.params.code);
  }
  res.json({ success: true });
});

router.post('/rooms/:code/bot', (req, res) => {
  const { hostId, slot, action } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  if (action === 'add') room.players[`BOT_${slot}`] = { name: 'Bot', slot: Number(slot), isBot: true };
  else if (action === 'remove') delete room.players[`BOT_${slot}`];

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

router.post('/rooms/:code/swap', (req, res) => {
  const { hostId, playerId1, playerId2 } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const p1 = room.players[playerId1], p2 = room.players[playerId2];
  if (!p1 || !p2) return res.status(400).json({ error: 'Player not found' });
  const tmp = p1.slot; p1.slot = p2.slot; p2.slot = tmp;

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

router.post('/rooms/:code/promote', (req, res) => {
  const { hostId, audienceId, audienceName, slot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  applyPromote(req.params.code, hostId, audienceId, audienceName, Number(slot));
  res.json({ success: true });
});

router.post('/rooms/:code/replace_bot', (req, res) => {
  const { hostId, slot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  Object.keys(room.players).forEach(pid => {
    if (room.players[pid].slot === Number(slot) && pid.startsWith('BOT_')) delete room.players[pid];
  });
  room.players[`BOT_${slot}`] = { name: 'Bot', slot: Number(slot), isBot: true };

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ============================================================
// WEBSOCKET HANDLER
// ============================================================
function handleConnection(ws) {
  const socketId = crypto.randomUUID();
  connections.set(socketId, { ws, playerId: null, roomCode: null, isAudience: false });
  ws.send(JSON.stringify({ type: 'CONNECTED', socketId }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(socketId, msg);
    } catch (_) {}
  });

  ws.on('close', () => handleDisconnect(socketId));
  ws.on('error', (err) => console.error(`[WS] ${socketId}:`, err.message));
}

function handleWsMessage(socketId, msg) {
  const conn = connections.get(socketId);
  if (!conn) return;

  switch (msg.type) {

    case 'REGISTER': {
      const { playerId, roomCode, isAudience } = msg;
      if (!playerId || !roomCode) break;

      const old = playerConnections.get(playerId);
      if (old && old !== socketId) {
        const oldConn = connections.get(old);
        if (oldConn) oldConn.roomCode = null;
      }

      conn.playerId = playerId;
      conn.roomCode = roomCode;
      conn.isAudience = isAudience || false;
      playerConnections.set(playerId, socketId);
      ws_send(conn.ws, { type: 'REGISTERED', playerId, roomCode });
      break;
    }

    case 'PING':
      ws_send(conn.ws, { type: 'PONG', timestamp: Date.now() });
      break;

    // ── AWAY STATUS HANDLING ──
    case 'ACTION_AWAY': {
      const room = rooms.get(conn.roomCode);
      if (!room) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx !== -1) {
        gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', { slot: senderIdx, isAway: true, playerName: room.players[conn.playerId]?.name });
      }
      break;
    }

    case 'ACTION_RETURN': {
      const room = rooms.get(conn.roomCode);
      if (!room) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx !== -1) {
        gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', { slot: senderIdx, isAway: false, playerName: room.players[conn.playerId]?.name });
      }
      break;
    }

    case 'REQUEST_SYNC': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const gs = room.game;
      
      let slot = 0;
      let handStr = '';
      if (!conn.isAudience) {
        slot = getSlotIndex(room, conn.playerId);
        if (slot !== -1 && gs.hands[slot]) {
          handStr = gs.hands[slot].join(',');
        }
      }

      const syncData = {
        slot,
        isAudience: conn.isAudience,
        hand: handStr,
        turnIndex: gs.turnIndex,
        roundStarterIndex: gs.roundStarterIndex,
        trumpSuit: gs.trumpSuit,
        isTrumpRevealed: gs.isTrumpRevealed,
        currentTrickTrumpRevealer: gs.currentTrickTrumpRevealer,
        leadSuit: gs.leadSuit,
        handsPlayed: gs.handsPlayed,
        isBiddingPhase: gs.isBiddingPhase,
        isWaitingForTrump: gs.isWaitingForTrump,
        currentBid: gs.currentBid,
        bidder: gs.bidder,
        highestBidder: gs.highestBidder,
        currentBidderIdx: gs.currentBidderIdx,
        teamScore0: gs.teamScores[0],
        teamScore1: gs.teamScores[1],
        gamePointsTeam0: gs.gamePoints[0],
        gamePointsTeam1: gs.gamePoints[1],
        isDoublePhase: gs.isDoublePhase,
        isRedoublePhase: gs.isRedoublePhase,
        isDoubled: gs.isDoubled,
        isRedoubled: gs.isRedoubled,
        gamePointMultiplier: gs.gamePointMultiplier,
        isSingleHandPhase: gs.isSingleHandPhase,
        singleHandDeclarer: gs.singleHandDeclarer,
        sittingOutPlayer: gs.sittingOutPlayer,
        passedPlayers: gs.passedPlayers,
        pairShown: gs.pairShown,
        currentTrick: gs.currentTrick.map(pc => `${pc.playerIndex}-${pc.card}`).join(','),
      };

      gameEvent(conn.roomCode, 'SYNC_STATE', syncData, conn.playerId);
      break;
    }

    case 'ACTION_BID': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const gs = room.game;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1) break;

      if (msg.bid === 'PASS') applyBidPass(conn.roomCode, senderIdx);
      else {
        const bid = parseInt(msg.bid, 10);
        if (!isNaN(bid) && bid >= 16 && bid <= 28) applyBid(conn.roomCode, senderIdx, bid);
      }
      break;
    }

    case 'ACTION_TRUMP': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1 || !SUITS.includes(msg.suit)) break;
      applyTrumpSelect(conn.roomCode, senderIdx, msg.suit);
      break;
    }

    case 'ACTION_MOVE': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1 || !msg.card) break;
      applyMove(conn.roomCode, senderIdx, msg.card);
      break;
    }

    case 'ACTION_REVEAL': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1) break;
      applyRevealTrump(conn.roomCode, senderIdx);
      break;
    }

    case 'ACTION_SHOW_PAIR': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1) break;
      applyShowPair(conn.roomCode, senderIdx);
      break;
    }

    case 'ACTION_DOUBLE': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1) break;
      applyDoubleAction(conn.roomCode, senderIdx, msg.choice);
      break;
    }

    case 'ACTION_REDOUBLE': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1) break;
      applyRedoubleAction(conn.roomCode, senderIdx, msg.choice);
      break;
    }

    case 'ACTION_SINGLE': {
      const room = rooms.get(conn.roomCode);
      if (!room || !room.game) break;
      const senderIdx = getSlotIndex(room, conn.playerId);
      if (senderIdx === -1) break;
      applySingleHandAction(conn.roomCode, senderIdx, msg.choice);
      break;
    }

    case 'ACTION_NEXT_ROUND': {
      const room = rooms.get(conn.roomCode);
      if (!room || room.hostId !== conn.playerId) break;
      room.status = 'PLAYING';
      startNewRound(conn.roomCode);
      break;
    }

    case 'ACTION_CHAT': {
      if (!conn.roomCode || !msg.message) break;
      const room = rooms.get(conn.roomCode);
      if (!room) break;
      gameEvent(conn.roomCode, 'CHAT', { sender: conn.playerId, message: msg.message });
      break;
    }

    case 'ACTION_PROMOTE': {
      const room = rooms.get(conn.roomCode);
      if (!room || room.hostId !== conn.playerId) break;
      applyPromote(conn.roomCode, conn.playerId, msg.audienceId, msg.audienceName, Number(msg.slot));
      break;
    }

    default:
      break;
  }
}

function getSlotIndex(room, playerId) {
  const p = room.players[playerId];
  return p ? p.slot : -1;
}

function handleDisconnect(socketId) {
  const conn = connections.get(socketId);
  if (!conn) return;

  const { playerId, roomCode, isAudience } = conn;

  if (playerId && playerConnections.get(playerId) === socketId) {
    playerConnections.delete(playerId);
  }

  if (playerId && roomCode) {
    const room = rooms.get(roomCode);
    if (room) {
      if (isAudience) {
        delete room.audiences[playerId];
        broadcastRoomUpdate(roomCode);
      } else if (room.hostId === playerId) {
        // ── HOST MIGRATION LOGIC ──
        const oldHostSlot = getSlotIndex(room, playerId);
        let newHostId = null;

        if (oldHostSlot !== -1) {
          const partnerSlot = (oldHostSlot + 2) % 4;
          newHostId = Object.keys(room.players).find(pid => room.players[pid].slot === partnerSlot && !room.players[pid].isBot);
        }
        
        if (!newHostId) {
          newHostId = Object.keys(room.players).find(pid => pid !== playerId && !room.players[pid].isBot);
        }

        if (newHostId) {
          room.hostId = newHostId;
          room.hostName = room.players[newHostId].name;
          broadcastRoomUpdate(roomCode);
          gameEvent(roomCode, 'HOST_CHANGED', { newHostId: newHostId, newHostName: room.hostName });
          gameEvent(roomCode, 'CHAT', { sender: 'SERVER', message: `${room.hostName} is now the Host.` });
        } else {
          setTimeout(() => {
            if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
              const rCheck = rooms.get(roomCode);
              const hasHumans = Object.keys(rCheck.players).some(pid => !rCheck.players[pid].isBot);
              if (!hasHumans) {
                broadcastToRoom(roomCode, { type: 'ROOM_DELETED', reason: 'Host disconnected and no active players left' });
                rooms.delete(roomCode);
              }
            }
          }, 15000); // 15 seconds grace period
        }
      } 
      
      if (!isAudience) {
        if (room.game && room.status === 'PLAYING') {
          const slot = getSlotIndex(room, playerId);
          gameEvent(roomCode, 'PLAYER_DISCONNECTED', { playerId, slot });

          setTimeout(() => {
            if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
              const r2 = rooms.get(roomCode);
              if (r2 && r2.players[playerId]) {
                const s = r2.players[playerId].slot;
                const pName = r2.players[playerId].name;

                // ── SEAT RECOVERY LOGIC (Save player info before bot replacement) ──
                r2.disconnectedPlayers = r2.disconnectedPlayers || {};
                r2.disconnectedPlayers[playerId] = { slot: s, name: pName };

                delete r2.players[playerId];
                r2.players[`BOT_${s}`] = { name: 'Bot', slot: s, isBot: true };
                broadcastRoomUpdate(roomCode);
                gameEvent(roomCode, 'CHAT', { sender: 'SERVER', message: `${pName} disconnected. Bot took over Slot ${s + 1}.` });

                const gs = r2.game;
                if (gs) {
                  if (gs.isBiddingPhase && gs.currentBidderIdx === s) {
                    setTimeout(() => botBid(roomCode, s), 500);
                  } else if (gs.isWaitingForTrump && gs.bidder === s) {
                    setTimeout(() => botChooseTrump(roomCode, s), 500);
                  } else if (!gs.isBiddingPhase && !gs.isTrickEvaluating && gs.turnIndex === s) {
                    setTimeout(() => botPlay(roomCode, s), 500);
                  }
                }
              }
            }
          }, 15 * 1000);
        } else if (room.status === 'WAITING' && room.hostId !== playerId) {
            // Delete player if they disconnect during lobby waiting
            setTimeout(() => {
                if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
                    delete room.players[playerId];
                    broadcastRoomUpdate(roomCode);
                }
            }, 10000);
        }
      }
    }
  }

  connections.delete(socketId);
}

function ws_send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

module.exports = {
  router,
  handleConnection
};