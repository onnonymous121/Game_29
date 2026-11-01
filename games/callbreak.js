/**
 * CallBreak — Core Logic Module
 * Path: games/callbreak.js
 * =====================================================
 * কলব্রেকের সমস্ত রুলস, বিডিং, ট্রিক ভ্যালিডেশন এবং এআই বট লজিক।
 */

'use strict';

const rm = require('../roomManager');

// ============================================================
// CARD CONSTANTS & POWERS (52 Cards)
// ============================================================
const SUITS = ['s', 'd', 'c', 'h']; // Spades is default Trump
const RANKS = ['a', 'k', 'q', 'j', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const RANK_POWER = {
  'a': 14, 'k': 13, 'q': 12, 'j': 11, '10': 10,
  '9': 9,  '8': 8,  '7': 7,  '6': 6,  '5': 5,  '4': 4,  '3': 3, '2': 2
};

// ============================================================
// GAME STATE FACTORY WITH CUSTOM RULES
// ============================================================
function newGameState(roundStarterIndex = 0, customRules = {}) {
  return {
    deck: [],
    hands: [[], [], [], []],
    roundStarterIndex,
    currentRound: 1,
    totalRounds: customRules.totalRounds || 5,
    
    // Host Custom Rules
    rules: {
      mustBeat: customRules.mustBeat ?? true,
      mustTrump: customRules.mustTrump ?? true,
      freeSpadeLead: customRules.freeSpadeLead ?? true,
      eightTricksAutoWin: customRules.eightTricksAutoWin ?? true,
    },

    handsPlayed: 0,
    currentTrick: [],
    leadSuit: null,
    isSpadeBroken: false,

    isBiddingPhase: true,
    bids: [-1, -1, -1, -1],
    currentBidderIdx: roundStarterIndex,
    bidsCount: 0,

    trickWins: [0, 0, 0, 0], // Tricks won in current round by each player
    roundScores: [[0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0]], // Up to 5 rounds
    totalScores: [0, 0, 0, 0],
    
    turnIndex: 0,
    isTrickEvaluating: false,
  };
}

// ============================================================
// UTILITY HELPERS
// ============================================================
function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(`${s}_${r}`);
    }
  }
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
function cardPower(code) { return RANK_POWER[cardRank(code)] ?? 0; }

function getSlotAssignments(room) {
  const slots = ['BOT', 'BOT', 'BOT', 'BOT'];
  Object.entries(room.players).forEach(([pid, p]) => {
    if (p.slot >= 0 && p.slot < 4) {
      slots[p.slot] = p.isBot ? 'BOT' : pid;
    }
  });
  return slots;
}

// ============================================================
// AUTO-REDEAL CHECK (No Spades OR No Face Cards A, K, Q, J)
// ============================================================
function needsRedeal(hands) {
  for (let i = 0; i < 4; i++) {
    const hand = hands[i];
    const hasSpade = hand.some(c => cardSuit(c) === 's');
    const hasFaceCard = hand.some(c => ['a', 'k', 'q', 'j'].includes(cardRank(c)));
    if (!hasSpade || !hasFaceCard) {
      return true; // Redeal triggered
    }
  }
  return false;
}

// ============================================================
// GAME FLOW & ROUND START
// ============================================================
function startNewRound(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;

  const prevGame = room.game;
  const customRules = prevGame ? prevGame.rules : {};
  const totalRounds = prevGame ? prevGame.totalRounds : 5;
  const currentRound = prevGame ? prevGame.currentRound : 1;
  const starter = prevGame ? prevGame.roundStarterIndex : 0;
  const totalScores = prevGame ? prevGame.totalScores : [0, 0, 0, 0];

  const gs = newGameState(starter, customRules);
  gs.currentRound = currentRound;
  gs.totalRounds = totalRounds;
  gs.totalScores = totalScores;
  room.game = gs;
  room.status = 'PLAYING';

  gs.deck = buildDeck();
  shuffleDeck(gs.deck);

  for (let i = 0; i < 4; i++) {
    gs.hands[i] = [];
    for (let j = 0; j < 13; j++) {
      gs.hands[i].push(gs.deck.shift());
    }
    gs.hands[i].sort((a, b) => cardSuit(a).localeCompare(cardSuit(b)) || cardPower(b) - cardPower(a));
  }

  // Check Auto-Redeal conditions
  if (needsRedeal(gs.hands)) {
    rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'REDEAL', payload: { reason: 'Invalid hand distribution (No Spades or Face Cards)' } });
    setTimeout(() => startNewRound(roomCode), 2000);
    return;
  }

  rm.gameEvent(roomCode, 'ROUND_START', { round: gs.currentRound, roundStarterIndex: gs.roundStarterIndex });

  const slots = getSlotAssignments(room);
  for (let i = 0; i < 4; i++) {
    const pid = slots[i];
    if (pid !== 'BOT') {
      rm.gameEvent(roomCode, 'DEAL_13', {
        cards: gs.hands[i].join(','),
        slot: i,
        roundStarterIndex: gs.roundStarterIndex,
      }, pid);
    }
  }

  setTimeout(() => {
    gs.isBiddingPhase = true;
    gs.currentBidderIdx = gs.roundStarterIndex;
    processBidTurn(roomCode);
  }, 1000);
}

// ============================================================
// BIDDING PHASE
// ============================================================
function processBidTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase) return;

  if (gs.bidsCount === 4) {
    gs.isBiddingPhase = false;
    gs.turnIndex = gs.roundStarterIndex;
    rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'BIDDING_COMPLETE', payload: { bids: gs.bids } });
    setTimeout(() => playTurn(roomCode), 800);
    return;
  }

  rm.broadcastToRoom(roomCode, {
    type: 'GAME_EVENT',
    event: 'BID_TURN_INFO',
    payload: { currentBidderIdx: gs.currentBidderIdx }
  });

  const slots = getSlotAssignments(room);
  const pid = slots[gs.currentBidderIdx];
  if (pid === 'BOT') {
    setTimeout(() => botBid(roomCode, gs.currentBidderIdx), 1000);
  } else {
    rm.gameEvent(roomCode, 'BID_REQ', { currentBidderIdx: gs.currentBidderIdx }, pid);
  }
}

function applyBid(roomCode, senderIdx, bid) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== senderIdx) return;

  gs.bids[senderIdx] = bid;
  gs.bidsCount++;
  rm.gameEvent(roomCode, 'BID_INFO', { senderIdx, bid });

  gs.currentBidderIdx = (gs.currentBidderIdx + 1) % 4;
  processBidTurn(roomCode);
}

function botBid(roomCode, idx) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== idx) return;

  const hand = gs.hands[idx];
  let highCards = hand.filter(c => cardPower(c) >= 11).length; // A, K, Q, J
  let spades = hand.filter(c => cardSuit(c) === 's').length;
  
  let suggestedBid = Math.min(8, Math.max(1, Math.floor(highCards * 0.7 + spades * 0.3)));
  applyBid(roomCode, idx, suggestedBid);
}

// ============================================================
// PLAY TURN & VALIDATION
// ============================================================
function playTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  rm.gameEvent(roomCode, 'TURN', { turnIndex: gs.turnIndex });

  const slots = getSlotAssignments(room);
  if (slots[gs.turnIndex] === 'BOT') {
    setTimeout(() => botPlay(roomCode, gs.turnIndex), 1000);
  }
}

function getPlayableCards(hand, leadSuit, isSpadeBroken, rules) {
  if (!leadSuit) {
    if (rules.freeSpadeLead || isSpadeBroken) return hand;
    const nonSpades = hand.filter(c => cardSuit(c) !== 's');
    return nonSpades.length > 0 ? nonSpades : hand;
  }

  const leadCards = hand.filter(c => cardSuit(c) === leadSuit);
  if (leadCards.length > 0) return leadCards;

  const spades = hand.filter(c => cardSuit(c) === 's');
  if (rules.mustTrump && spades.length > 0) return spades;

  return hand; // Can play any card if no lead suit and no mandatory trump
}

function applyMove(roomCode, senderIdx, card) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isBiddingPhase || gs.isTrickEvaluating || gs.turnIndex !== senderIdx) return;

  const hand = gs.hands[senderIdx];
  if (!hand.includes(card)) return;

  if (cardSuit(card) === 's') gs.isSpadeBroken = true;

  gs.hands[senderIdx] = hand.filter(c => c !== card);

  if (gs.currentTrick.length === 0) {
    gs.leadSuit = cardSuit(card);
  }
  gs.currentTrick.push({ playerIndex: senderIdx, card });

  rm.gameEvent(roomCode, 'MOVE_UI', { playerIndex: senderIdx, card });

  if (gs.currentTrick.length === 4) {
    gs.isTrickEvaluating = true;
    setTimeout(() => evaluateTrick(roomCode), 800);
  } else {
    gs.turnIndex = (gs.turnIndex + 1) % 4;
    setTimeout(() => playTurn(roomCode), 300);
  }
}

function botPlay(roomCode, idx) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isTrickEvaluating || gs.turnIndex !== idx) return;

  const hand = gs.hands[idx];
  const playable = getPlayableCards(hand, gs.leadSuit, gs.isSpadeBroken, gs.rules);
  const card = playable[Math.floor(Math.random() * playable.length)];

  applyMove(roomCode, idx, card);
}

// ============================================================
// EVALUATE TRICK
// ============================================================
function evaluateTrick(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  const lead = gs.leadSuit;
  let winIdx = 0;
  let bestCard = gs.currentTrick[0].card;
  let bestIsSpade = cardSuit(bestCard) === 's';

  for (let i = 1; i < 4; i++) {
    const pc = gs.currentTrick[i].card;
    const pIsSpade = cardSuit(pc) === 's';

    if (pIsSpade && !bestIsSpade) {
      bestCard = pc;
      winIdx = i;
      bestIsSpade = true;
    } else if (pIsSpade === bestIsSpade) {
      if (cardSuit(pc) === (bestIsSpade ? 's' : lead)) {
        if (cardPower(pc) > cardPower(bestCard)) {
          bestCard = pc;
          winIdx = i;
        }
      }
    }
  }

  const winner = gs.currentTrick[winIdx].playerIndex;
  gs.trickWins[winner]++;
  gs.handsPlayed++;

  rm.gameEvent(roomCode, 'TRICK_WIN', { winner, wins: gs.trickWins[winner] });

  gs.currentTrick = [];
  gs.leadSuit = null;
  gs.isTrickEvaluating = false;

  if (gs.handsPlayed === 13) {
    resolveRound(roomCode);
  } else {
    gs.turnIndex = winner;
    setTimeout(() => playTurn(roomCode), 500);
  }
}

// ============================================================
// RESOLVE ROUND & MATCH
// ============================================================
function resolveRound(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  const roundScores = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const bid = gs.bids[i];
    const won = gs.trickWins[i];
    if (won >= bid) {
      roundScores[i] = bid + (won - bid) * 0.1;
    } else {
      roundScores[i] = -bid;
    }
    gs.totalScores[i] += roundScores[i];
  }

  gs.roundScores[gs.currentRound - 1] = roundScores;

  rm.gameEvent(roomCode, 'ROUND_OVER', {
    round: gs.currentRound,
    roundScores,
    totalScores: gs.totalScores,
    bids: gs.bids,
    trickWins: gs.trickWins,
  });

  if (gs.currentRound >= gs.totalRounds) {
    room.status = 'WAITING';
    let maxScore = -999;
    let winnerSlot = 0;
    for (let i = 0; i < 4; i++) {
      if (gs.totalScores[i] > maxScore) {
        maxScore = gs.totalScores[i];
        winnerSlot = i;
      }
    }
    const slots = getSlotAssignments(room);
    const winningPlayerId = slots[winnerSlot];
    rm.resolveUniversalGame(roomCode, [winnerSlot]);
  } else {
    gs.currentRound++;
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    room.status = 'WAITING';
  }
}

// ============================================================
// HANDLERS FOR ROOM MANAGER
// ============================================================
function initGame(roomCode, customRules = {}) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  room.game = newGameState(0, customRules);
  setTimeout(() => startNewRound(roomCode), 2000);
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  const isAudience = !!room.audiences[playerId];
  const senderIdx = isAudience ? -1 : Object.entries(room.players).find(([id, p]) => id === playerId)?.[1]?.slot ?? -1;

  switch (msg.type) {
    case 'REQUEST_SYNC':
      rm.gameEvent(roomCode, 'SYNC_STATE', {
        slot: senderIdx,
        isAudience,
        hand: (!isAudience && senderIdx !== -1) ? gs.hands[senderIdx].join(',') : '',
        turnIndex: gs.turnIndex,
        roundStarterIndex: gs.roundStarterIndex,
        currentRound: gs.currentRound,
        totalRounds: gs.totalRounds,
        isBiddingPhase: gs.isBiddingPhase,
        bids: gs.bids,
        trickWins: gs.trickWins,
        totalScores: gs.totalScores,
        currentBidderIdx: gs.currentBidderIdx,
        leadSuit: gs.leadSuit,
        currentTrick: gs.currentTrick.map(pc => `${pc.playerIndex}-${pc.card}`).join(','),
      }, playerId);
      break;

    case 'ACTION_BID':
      if (senderIdx === -1) break;
      const bid = parseInt(msg.bid, 10);
      if (!isNaN(bid) && bid >= 1 && bid <= 8) {
        applyBid(roomCode, senderIdx, bid);
      }
      break;

    case 'ACTION_MOVE':
      if (senderIdx === -1 || !msg.card) break;
      applyMove(roomCode, senderIdx, msg.card);
      break;

    case 'ACTION_NEXT_ROUND':
      if (room.hostId !== playerId) break;
      startNewRound(roomCode);
      break;
  }
}

function handlePlayerDisconnectDuringGame(roomCode, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isBiddingPhase && gs.currentBidderIdx === slot) {
    setTimeout(() => botBid(roomCode, slot), 500);
  } else if (!gs.isBiddingPhase && gs.turnIndex === slot) {
    setTimeout(() => botPlay(roomCode, slot), 500);
  }
}

function syncPromotedAudience(roomCode, audienceId, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  handleGameAction(roomCode, audienceId, { type: 'REQUEST_SYNC' });
}

module.exports = {
  initGame,
  handleGameAction,
  handlePlayerDisconnectDuringGame,
  syncPromotedAudience
};