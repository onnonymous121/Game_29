/**
 * Game 29 — Core Logic Module
 * Path: games/game29.js
 * =====================================================
 * গেম ২৯ এর সমস্ত রুলস, বিডিং, ট্রিক ইভ্যালুয়েশন এবং বট লজিক এখানে আছে।
 * এটি সেন্ট্রাল roomManager এর সাথে যোগাযোগ করে কাজ করবে।
 */

'use strict';

const rm = require('../roomManager');

// ============================================================
// CARD CONSTANTS
// ============================================================
const SUITS  = ['s', 'd', 'c', 'h'];
const RANKS  = ['j', '9', 'a', '10', 'k', 'q', '8', '7'];
const RANK_VALUES = { j:3, '9':2, a:1, '10':1, k:0, q:0, '8':0, '7':0 };
const RANK_POWER  = { j:8, '9':7, a:6, '10':5, k:4, q:3, '8':2, '7':1 };

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
// UTILITY HELPERS
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

function getSlotAssignments(room) {
  const slots = ['BOT', 'BOT', 'BOT', 'BOT'];
  Object.entries(room.players).forEach(([pid, p]) => {
    if (p.slot >= 0 && p.slot < 4) slots[p.slot] = p.isBot ? 'BOT' : pid;
  });
  return slots;
}

// ============================================================
// GAME LOGIC FLOW
// ============================================================
function startNewRound(roomCode) {
  const room = rm.rooms.get(roomCode);
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
    rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'REDEAL', payload: {} });
    setTimeout(() => startNewRound(roomCode), 1500);
    return;
  }

  rm.gameEvent(roomCode, 'ROUND_START', { roundStarterIndex: gs.roundStarterIndex });

  const slots = getSlotAssignments(room);
  rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'DEAL_4_INFO', payload: { roundStarterIndex: gs.roundStarterIndex } });

  setTimeout(() => {
    for (let i = 0; i < 4; i++) {
      const pid = slots[i];
      if (pid !== 'BOT') {
        rm.gameEvent(roomCode, 'DEAL_4', {
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase) return;

  const passedCount = gs.passedPlayers.filter(Boolean).length;

  if (passedCount === 4) {
    gs.isBiddingPhase = false;
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    rm.gameEvent(roomCode, 'REDEAL', {});
    setTimeout(() => startNewRound(roomCode), 1500);
    return;
  }

  if (passedCount >= 3 && gs.highestBidder !== -1) {
    gs.isBiddingPhase = false;
    gs.isWaitingForTrump = true;
    gs.bidder = gs.highestBidder;
    rm.gameEvent(roomCode, 'BID_WINNER', { bidder: gs.bidder, currentBid: gs.currentBid });

    const slots = getSlotAssignments(room);
    if (slots[gs.bidder] === 'BOT') {
      setTimeout(() => botChooseTrump(roomCode, gs.bidder), 800);
    } else {
      rm.gameEvent(roomCode, 'TRUMP_REQ', {}, slots[gs.bidder]);
    }
    return;
  }

  const slots = getSlotAssignments(room);
  const pid = slots[gs.currentBidderIdx];
  if (pid === 'BOT') {
    setTimeout(() => botBid(roomCode, gs.currentBidderIdx), 1000);
  } else {
    rm.gameEvent(roomCode, 'BID_REQ', {
      defenderIdx: gs.defenderIdx,
      challengerIdx: gs.challengerIdx,
      currentBid: gs.currentBid,
      currentBidderIdx: gs.currentBidderIdx,
    }, pid);
  }
}

function applyBid(roomCode, senderIdx, bid) {
  const room = rm.rooms.get(roomCode);
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

  rm.gameEvent(roomCode, 'BID_INFO', { bid, senderIdx });
  processBidTurn(roomCode);
}

function applyBidPass(roomCode, senderIdx) {
  const room = rm.rooms.get(roomCode);
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

  rm.gameEvent(roomCode, 'BID_PASS_INFO', { senderIdx });
  processBidTurn(roomCode);
}

function botBid(roomCode, idx) {
  const room = rm.rooms.get(roomCode);
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isWaitingForTrump || gs.bidder !== senderIdx) return;

  gs.isWaitingForTrump = false;
  gs.trumpSuit = suit;
  gs.isTrumpRevealed = false;
  rm.gameEvent(roomCode, 'TRUMP_SET', { suit: 'HIDDEN' });
  finishDealing(roomCode);
}

function botChooseTrump(roomCode, idx) {
  const room = rm.rooms.get(roomCode);
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
  
  rm.gameEvent(roomCode, 'TRUMP_SET', { suit: 'HIDDEN' });
  finishDealing(roomCode);
}

function finishDealing(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (gs.deck.length > 0) gs.hands[i].push(gs.deck.shift());
    }
  }

  const slots = getSlotAssignments(room);
  rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'DEAL_REST_INFO', payload: {} });

  for (let i = 0; i < 4; i++) {
    const pid = slots[i];
    if (pid !== 'BOT') {
      rm.gameEvent(roomCode, 'DEAL_REST', {
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isTrumpRevealed || !gs.trumpSuit) return;

  gs.isTrumpRevealed = true;
  gs.currentTrickTrumpRevealer = senderIdx;
  rm.gameEvent(roomCode, 'TRUMP_REVEAL', { suit: gs.trumpSuit, revealerIdx: senderIdx });
}

// ── SHOW PAIR ────────────────────────────────────────────────
function applyShowPair(roomCode, senderIdx) {
  const room = rm.rooms.get(roomCode);
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

  rm.gameEvent(roomCode, 'PAIR_SHOWN', { senderIdx, currentBid: gs.currentBid });
}

// ── DOUBLE/REDOUBLE/SINGLE HAND ──────────────────────────────
function startDoublePhase(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isDoublePhase = true;
  gs.doublePasses = [false, false, false, false];
  rm.gameEvent(roomCode, 'DOUBLE_PHASE_START', {});

  const slots = getSlotAssignments(room);
  const opp1 = (gs.bidder + 1) % 4;
  const opp2 = (gs.bidder + 3) % 4;

  if (slots[opp1] === 'BOT') gs.doublePasses[opp1] = true;
  else rm.gameEvent(roomCode, 'REQ_DOUBLE', {}, slots[opp1]);

  if (slots[opp2] === 'BOT') gs.doublePasses[opp2] = true;
  else rm.gameEvent(roomCode, 'REQ_DOUBLE', {}, slots[opp2]);

  if (gs.doublePasses[opp1] && gs.doublePasses[opp2]) {
    gs.isDoublePhase = false;
    setTimeout(() => finishDoublePhase(roomCode), 300);
  }
}

function applyDoubleAction(roomCode, senderIdx, choice) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isDoublePhase) return;

  const opp1 = (gs.bidder + 1) % 4;
  const opp2 = (gs.bidder + 3) % 4;

  if (choice === 'DOUBLE') {
    gs.isDoublePhase = false;
    gs.isDoubled = true;
    gs.gamePointMultiplier = 2;
    rm.gameEvent(roomCode, 'DOUBLE_MADE_INFO', { senderIdx });
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isRedoublePhase = true;
  gs.redoublePasses = [false, false, false, false];
  rm.gameEvent(roomCode, 'REDOUBLE_PHASE_START', {});

  const slots = getSlotAssignments(room);
  const bid1 = gs.bidder;
  const bid2 = (gs.bidder + 2) % 4;

  if (slots[bid1] === 'BOT') gs.redoublePasses[bid1] = true;
  else rm.gameEvent(roomCode, 'REQ_REDOUBLE', {}, slots[bid1]);

  if (slots[bid2] === 'BOT') gs.redoublePasses[bid2] = true;
  else rm.gameEvent(roomCode, 'REQ_REDOUBLE', {}, slots[bid2]);

  if (gs.redoublePasses[bid1] && gs.redoublePasses[bid2]) {
    gs.isRedoublePhase = false;
    setTimeout(() => finishDoublePhase(roomCode), 300);
  }
}

function applyRedoubleAction(roomCode, senderIdx, choice) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isRedoublePhase) return;

  const bid1 = gs.bidder;
  const bid2 = (gs.bidder + 2) % 4;

  if (choice === 'REDOUBLE') {
    gs.isRedoublePhase = false;
    gs.isRedoubled = true;
    gs.gamePointMultiplier = 4;
    rm.gameEvent(roomCode, 'REDOUBLE_MADE_INFO', { senderIdx });
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  gs.isDoublePhase = false;
  gs.isRedoublePhase = false;
  startSingleHandPhase(roomCode);
}

function startSingleHandPhase(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isSingleHandPhase = true;
  gs.singleHandPasses = [false, false, false, false];
  rm.gameEvent(roomCode, 'SINGLE_HAND_PHASE_START', {});

  const slots = getSlotAssignments(room);
  for (let i = 0; i < 4; i++) {
    if (slots[i] === 'BOT') gs.singleHandPasses[i] = true;
    else rm.gameEvent(roomCode, 'REQ_SINGLE_HAND', {}, slots[i]);
  }

  if (gs.singleHandPasses.filter(Boolean).length === 4) {
    gs.isSingleHandPhase = false;
    setTimeout(() => playTurn(roomCode), 300);
  }
}

function applySingleHandAction(roomCode, senderIdx, choice) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isSingleHandPhase) return;

  if (choice === 'DECLARE') {
    gs.isSingleHandPhase = false;
    gs.singleHandDeclarer = senderIdx;
    gs.sittingOutPlayer = (senderIdx + 2) % 4;
    rm.gameEvent(roomCode, 'SINGLE_HAND_MADE_INFO', { senderIdx });
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (gs.turnIndex === gs.sittingOutPlayer) {
    gs.turnIndex = (gs.turnIndex + 1) % 4;
  }

  rm.gameEvent(roomCode, 'TURN', { turnIndex: gs.turnIndex });

  const slots = getSlotAssignments(room);
  if (slots[gs.turnIndex] === 'BOT') {
    setTimeout(() => botPlay(roomCode, gs.turnIndex), 1000);
  }
}

function applyMove(roomCode, senderIdx, card) {
  const room = rm.rooms.get(roomCode);
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
    rm.gameEvent(roomCode, 'TRUMP_REVEAL', { suit: gs.trumpSuit, revealerIdx: senderIdx });
  }

  gs.hands[senderIdx] = hand.filter(c => c !== card);

  if (gs.currentTrick.length === 0) gs.leadSuit = cardSuit(card);
  gs.currentTrick.push({ playerIndex: senderIdx, card });

  checkAndShowPairAuto(roomCode, senderIdx);

  rm.gameEvent(roomCode, 'MOVE_UI', { playerIndex: senderIdx, card });

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
  const room = rm.rooms.get(roomCode);
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
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isTrickEvaluating || gs.turnIndex !== idx) return;

  const hand = gs.hands[idx];
  if (!hand.length) return;

  checkAndShowPairAuto(roomCode, idx);

  let card;
  
  // ── স্মার্ট এআই লজিক: প্রথম চাল দেওয়ার সময় ──
  if (gs.currentTrick.length === 0) {
    const aces = hand.filter(c => cardRank(c) === 'a');
    if (aces.length > 0) {
      // যদি টেক্কা থাকে, সেটা আগে খেলে পয়েন্ট নিশ্চিত করবে
      card = aces[Math.floor(Math.random() * aces.length)];
    } else {
      card = hand.reduce((a, b) => cardPower(a) > cardPower(b) ? a : b);
    }
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
        // ── স্মার্ট এআই লজিক: পার্টনারকে পয়েন্ট গছানো ──
        card = followSuit.reduce((a, b) => cardValue(a) > cardValue(b) ? a : b);
      } else {
        card = followSuit.reduce((a, b) => cardPower(a) > cardPower(b) ? a : b);
      }
    } else {
      if (isPartnerWinning) {
        // রঙ না থাকলে অন্য রঙের সবচেয়ে বেশি পয়েন্টের তাস (১০ বা টেক্কা) পার্টনারকে দিয়ে দেবে
        const nonTrumps = hand.filter(c => cardSuit(c) !== gs.trumpSuit);
        if (nonTrumps.length) {
          card = nonTrumps.reduce((a, b) => cardValue(a) > cardValue(b) ? a : b);
        } else {
          card = hand[0];
        }
      } else {
        const trumpCards = hand.filter(c => cardSuit(c) === gs.trumpSuit);
        if (trumpCards.length) {
          card = trumpCards.reduce((a, b) => cardPower(a) < cardPower(b) ? a : b);
        } else {
          card = hand.reduce((a, b) => (cardValue(a) + cardPower(a)) < (cardValue(b) + cardPower(b)) ? a : b);
        }
      }
    }
  }

  applyMove(roomCode, idx, card);
}

// ── EVALUATE TRICK ───────────────────────────────────────────
function evaluateTrick(roomCode) {
  const room = rm.rooms.get(roomCode);
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

  rm.gameEvent(roomCode, 'TRICK_WIN', { winner, pts });

  gs.currentTrick = [];
  gs.leadSuit = null;
  gs.currentTrickTrumpRevealer = null;
  gs.handsPlayed++;
  gs.isTrickEvaluating = false;

  if (gs.handsPlayed === 7 && !gs.isTrumpRevealed) {
    rm.gameEvent(roomCode, 'ROUND_CANCELLED_NO_TRUMP', {});
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    setTimeout(() => startNewRound(roomCode), 3000);
    return;
  }

  if (gs.singleHandDeclarer !== -1 && winner !== gs.singleHandDeclarer) {
    const declTeam = gs.singleHandDeclarer % 2;
    gs.gamePoints[declTeam] -= 6;
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    rm.gameEvent(roomCode, 'ROUND_OVER', {
      gamePointsTeam0: gs.gamePoints[0],
      gamePointsTeam1: gs.gamePoints[1],
      code: 'SingleHandLost',
    });
    room.status = 'WAITING';
    
    // সিঙ্গেল হ্যান্ড হারলে বিপক্ষ দল জয়ী হবে
    const opponentTeam = declTeam === 0 ? [1, 3] : [0, 2];
    rm.resolveUniversalGame(roomCode, opponentTeam);
    return;
  }

  if (gs.handsPlayed === 8) {
    resolveRound(roomCode);
  } else {
    gs.turnIndex = winner;
    setTimeout(() => playTurn(roomCode), 500);
  }
}

// ── RESOLVE ROUND ─────────────────────────────────────────────
function resolveRound(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  let code = '';
  let winningSlots = [];

  if (gs.singleHandDeclarer !== -1) {
    const declTeam = gs.singleHandDeclarer % 2;
    gs.gamePoints[declTeam] += 6;
    code = 'SingleHandWon';
    // সিঙ্গেল হ্যান্ড জিতলে ডিক্লেয়ারারের দল জয়ী হবে
    winningSlots = declTeam === 0 ? [0, 2] : [1, 3];
  } else {
    const bidTeam = gs.bidder % 2;
    const bidderScore = gs.teamScores[bidTeam];
    
    if (bidderScore >= gs.currentBid) {
      gs.gamePoints[bidTeam] += (1 * gs.gamePointMultiplier);
      code = bidTeam === 0 ? 'Won' : 'ThemWon';
      // বিডার জিতলে তার দল জয়ী হবে
      winningSlots = bidTeam === 0 ? [0, 2] : [1, 3];
    } else {
      gs.gamePoints[bidTeam] -= (1 * gs.gamePointMultiplier);
      code = bidTeam === 0 ? 'Lost' : 'ThemLost';
      // বিডার হারলে বিপক্ষ দল জয়ী হবে
      winningSlots = bidTeam === 0 ? [1, 3] : [0, 2];
    }
  }

  gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;

  rm.gameEvent(roomCode, 'ROUND_OVER', {
    gamePointsTeam0: gs.gamePoints[0],
    gamePointsTeam1: gs.gamePoints[1],
    teamScore0: gs.teamScores[0],
    teamScore1: gs.teamScores[1],
    code,
    bidder: gs.bidder,
    currentBid: gs.currentBid,
  });

  room.status = 'WAITING';

  // ── সেন্ট্রাল ইউনিভার্সাল গেম রেজোলিউশন ফাংশন কল করা হলো ──
  rm.resolveUniversalGame(roomCode, winningSlots);
}

// ============================================================
// EXPORTED INTERFACES FOR ROOM MANAGER
// ============================================================

function initGame(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  room.game = newGameState(1); 
  setTimeout(() => {
    startNewRound(roomCode);
  }, 2500);
}

function getSlotIndex(room, playerId) {
  const p = room.players[playerId];
  return p ? p.slot : -1;
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  let senderIdx = -1;
  const isAudience = !!room.audiences[playerId];
  
  if (!isAudience) {
    senderIdx = getSlotIndex(room, playerId);
  }

  switch (msg.type) {
    case 'REQUEST_SYNC': {
      let handStr = '';
      if (!isAudience && senderIdx !== -1 && gs.hands[senderIdx]) {
        handStr = gs.hands[senderIdx].join(',');
      }

      const syncData = {
        slot: senderIdx,
        isAudience,
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

      rm.gameEvent(roomCode, 'SYNC_STATE', syncData, playerId);
      break;
    }

    case 'ACTION_BID': {
      if (senderIdx === -1) break;
      if (msg.bid === 'PASS') applyBidPass(roomCode, senderIdx);
      else {
        const bid = parseInt(msg.bid, 10);
        if (!isNaN(bid) && bid >= 16 && bid <= 28) applyBid(roomCode, senderIdx, bid);
      }
      break;
    }

    case 'ACTION_TRUMP': {
      if (senderIdx === -1 || !SUITS.includes(msg.suit)) break;
      applyTrumpSelect(roomCode, senderIdx, msg.suit);
      break;
    }

    case 'ACTION_MOVE': {
      if (senderIdx === -1 || !msg.card) break;
      applyMove(roomCode, senderIdx, msg.card);
      break;
    }

    case 'ACTION_REVEAL': {
      if (senderIdx === -1) break;
      applyRevealTrump(roomCode, senderIdx);
      break;
    }

    case 'ACTION_SHOW_PAIR': {
      if (senderIdx === -1) break;
      applyShowPair(roomCode, senderIdx);
      break;
    }

    case 'ACTION_DOUBLE': {
      if (senderIdx === -1) break;
      applyDoubleAction(roomCode, senderIdx, msg.choice);
      break;
    }

    case 'ACTION_REDOUBLE': {
      if (senderIdx === -1) break;
      applyRedoubleAction(roomCode, senderIdx, msg.choice);
      break;
    }

    case 'ACTION_SINGLE': {
      if (senderIdx === -1) break;
      applySingleHandAction(roomCode, senderIdx, msg.choice);
      break;
    }

    case 'ACTION_NEXT_ROUND': {
      if (room.hostId !== playerId) break;
      room.status = 'PLAYING';
      startNewRound(roomCode);
      break;
    }
  }
}

function handlePlayerDisconnectDuringGame(roomCode, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
  if (gs.isBiddingPhase && gs.currentBidderIdx === slot) {
    setTimeout(() => botBid(roomCode, slot), 500);
  } else if (gs.isWaitingForTrump && gs.bidder === slot) {
    setTimeout(() => botChooseTrump(roomCode, slot), 500);
  } else if (!gs.isBiddingPhase && !gs.isTrickEvaluating && gs.turnIndex === slot) {
    setTimeout(() => botPlay(roomCode, slot), 500);
  }
}

function syncPromotedAudience(roomCode, audienceId, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
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

  rm.gameEvent(roomCode, 'SYNC_STATE', syncData, audienceId);
}

module.exports = {
  initGame,
  handleGameAction,
  handlePlayerDisconnectDuringGame,
  syncPromotedAudience
};