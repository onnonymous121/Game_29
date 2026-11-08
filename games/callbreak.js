/**
 * CallBreak — Core Logic Module
 * Path: games/callbreak.js
 * =====================================================
 * Pre-game Host Rule Selection Phase, Live Audio Broadcast,
 * Strict Rule Validation, Smart Bot, Sync Recovery & Ping/Pong.
 * (Browser copy-safe: No raw angle brackets used)
 */

'use strict';

const rm = require('../roomManager');

// ============================================================
// CARD CONSTANTS & POWERS (52 Cards)
// ============================================================
const SUITS = ['s', 'd', 'c', 'h']; // Spades ('s') is default Trump
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

    // Pre-game Host Rule Selection Phase Flag
    isRuleSelectionPhase: false,

    // Host Custom Rules
    rules: {
      mustBeat: customRules.mustBeat ?? true,                   // Must Beat / Must Over
      mustTrump: customRules.mustTrump ?? true,                 // Must Play Trump (Spade) when void
      noSpadeFirstTrick: customRules.noSpadeFirstTrick ?? true, // No Trump (Spade) play in 1st trick
      freeSpadeLead: customRules.freeSpadeLead ?? true,
      eightTricksAutoWin: customRules.eightTricksAutoWin ?? true,
    },

    handsPlayed: 0,
    currentTrick: [],
    leadSuit: null,
    isSpadeBroken: false,

    isBiddingPhase: false,
    bids: [-1, -1, -1, -1],
    currentBidderIdx: roundStarterIndex,
    bidsCount: 0,

    trickWins: [0, 0, 0, 0],
    roundScores: [[0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0]],
    totalScores: [0, 0, 0, 0],

    turnIndex: 0,
    isTrickEvaluating: false,
    voidSuits: [[], [], [], []],
    lastSyncReports: {},
  };
}

// ============================================================
// UTILITY HELPERS (Angle-Bracket Free)
// ============================================================
function isMore(a, b) {
  return a !== b && Math.max(a, b) === a;
}

function isLess(a, b) {
  return a !== b && Math.min(a, b) === a;
}

function isAtLeast(a, b) {
  return a === b || Math.max(a, b) === a;
}

function isAtMost(a, b) {
  return a === b || Math.min(a, b) === a;
}

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
  let i = deck.length - 1;
  while (isMore(i, 0)) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
    i--;
  }
}

function cardSuit(code) { return code ? code.split('_')[0] : ''; }
function cardRank(code) { return code ? code.split('_')[1] : ''; }
function cardPower(code) { return RANK_POWER[cardRank(code)] ?? 0; }

function getSlotAssignments(room) {
  const slots = ['BOT', 'BOT', 'BOT', 'BOT'];
  Object.entries(room.players).forEach(([pid, p]) => {
    if (isAtLeast(p.slot, 0) && isLess(p.slot, 4)) {
      slots[p.slot] = p.isBot ? 'BOT' : pid;
    }
  });
  return slots;
}

function getSlotIndex(room, playerId) {
  const p = room.players[playerId];
  return p ? p.slot : -1;
}

function buildRulesSummaryText(rules) {
  const r1 = rules.mustBeat ? 'Must Over ON' : 'Must Over OFF';
  const r2 = rules.mustTrump ? 'Must Trump ON' : 'Must Trump OFF';
  const r3 = rules.noSpadeFirstTrick ? 'No Trump in First Trick ON' : 'No Trump in First Trick OFF';
  return `${r1}, ${r2}, ${r3}`;
}

// ============================================================
// AUTO-REDEAL CHECK (No Spades OR No Face Cards A, K, Q, J)
// ============================================================
function getRedealReason(hands) {
  for (const i of [0, 1, 2, 3]) {
    const hand = hands[i] || [];
    const hasSpade = hand.some(c => cardSuit(c) === 's');
    if (!hasSpade) {
      return `Player ${i + 1} has no Spades. Redealing cards...`;
    }
    const hasFaceCard = hand.some(c => ['a', 'k', 'q', 'j'].includes(cardRank(c)));
    if (!hasFaceCard) {
      return `Player ${i + 1} has no Face Cards (A, K, Q, J). Redealing cards...`;
    }
  }
  return null;
}

// ============================================================
// PRE-GAME RULE SELECTION PHASE
// ============================================================
function startRuleSelectionPhase(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.isRuleSelectionPhase = true;
  gs.isBiddingPhase = false;
  room.status = 'PLAYING';

  rm.broadcastToRoom(roomCode, {
    type: 'GAME_EVENT',
    event: 'RULE_SELECTION_START',
    payload: {
      rules: gs.rules,
      totalRounds: gs.totalRounds,
      announcement: 'Host is selecting custom rules for this match. Please wait.',
    }
  });
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
  const roundScores = prevGame ? prevGame.roundScores : [[0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0]];

  const gs = newGameState(starter, { ...customRules, totalRounds });
  gs.isRuleSelectionPhase = false;
  gs.currentRound = currentRound;
  gs.totalRounds = totalRounds;
  gs.totalScores = totalScores;
  gs.roundScores = roundScores;
  room.game = gs;
  room.status = 'PLAYING';

  gs.deck = buildDeck();
  shuffleDeck(gs.deck);

  for (const i of [0, 1, 2, 3]) {
    gs.hands[i] = gs.deck.splice(0, 13);
    gs.hands[i].sort((a, b) => cardSuit(a).localeCompare(cardSuit(b)) || (cardPower(b) - cardPower(a)));
  }

  // Redeal if any player has no Spades or no Face Cards
  const redealReason = getRedealReason(gs.hands);
  if (redealReason) {
    rm.broadcastToRoom(roomCode, {
      type: 'GAME_EVENT',
      event: 'REDEAL',
      payload: { reason: redealReason }
    });
    setTimeout(() => startNewRound(roomCode), 1800);
    return;
  }

  rm.gameEvent(roomCode, 'ROUND_START', {
    round: gs.currentRound,
    totalRounds: gs.totalRounds,
    roundStarterIndex: gs.roundStarterIndex,
    rules: gs.rules,
  });

  const slots = getSlotAssignments(room);
  for (const i of [0, 1, 2, 3]) {
    const pid = slots[i];
    if (pid !== 'BOT') {
      rm.gameEvent(roomCode, 'DEAL_13', {
        cards: gs.hands[i].join(','),
        slot: i,
        roundStarterIndex: gs.roundStarterIndex,
        rules: gs.rules,
      }, pid);
    }
  }

  setTimeout(() => {
    if (!room.game || room.game !== gs) return;
    gs.isBiddingPhase = true;
    gs.currentBidderIdx = gs.roundStarterIndex;
    processBidTurn(roomCode);
  }, 1000);
}

// ============================================================
// BIDDING PHASE (1 - 13)
// ============================================================
function processBidTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase) return;

  if (isAtLeast(gs.bidsCount, 4)) {
    gs.isBiddingPhase = false;
    gs.turnIndex = gs.roundStarterIndex;
    rm.broadcastToRoom(roomCode, {
      type: 'GAME_EVENT',
      event: 'BIDDING_COMPLETE',
      payload: { bids: gs.bids }
    });
    setTimeout(() => playTurn(roomCode), 800);
    return;
  }

  // Single unified event so client never announces twice
  rm.broadcastToRoom(roomCode, {
    type: 'GAME_EVENT',
    event: 'BID_TURN_INFO',
    payload: { currentBidderIdx: gs.currentBidderIdx }
  });

  const slots = getSlotAssignments(room);
  const pid = slots[gs.currentBidderIdx];
  if (pid === 'BOT') {
    setTimeout(() => botBid(roomCode, gs.currentBidderIdx), 1000);
  }
}

function applyBid(roomCode, senderIdx, bid) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== senderIdx) return;

  gs.bids[senderIdx] = bid;
  gs.bidsCount = gs.bids.filter(b => isAtLeast(b, 1) && isAtMost(b, 13)).length;
  rm.gameEvent(roomCode, 'BID_INFO', { senderIdx, bid });

  gs.currentBidderIdx = (gs.currentBidderIdx + 1) % 4;
  processBidTurn(roomCode);
}

function botBid(roomCode, idx) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== idx) return;

  const hand = gs.hands[idx] || [];
  const acesAndKings = hand.filter(c => ['a', 'k'].includes(cardRank(c)) && cardSuit(c) !== 's').length;
  const spades = hand.filter(c => cardSuit(c) === 's');
  const highSpades = spades.filter(c => isAtLeast(cardPower(c), 11)).length;
  const extraSpades = Math.max(0, spades.length - 3);

  const estimated = Math.round(acesAndKings * 0.8 + highSpades * 0.9 + extraSpades * 0.7);
  const suggestedBid = Math.min(13, Math.max(1, estimated));

  applyBid(roomCode, idx, suggestedBid);
}

// ============================================================
// PLAY TURN & STRICT RULE VALIDATION
// ============================================================
function playTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isRuleSelectionPhase || gs.isBiddingPhase || gs.isTrickEvaluating) return;

  rm.gameEvent(roomCode, 'TURN', { turnIndex: gs.turnIndex });

  const slots = getSlotAssignments(room);
  if (slots[gs.turnIndex] === 'BOT') {
    setTimeout(() => botPlay(roomCode, gs.turnIndex), 1000);
  }
}

function getPlayableCards(hand, currentTrick, leadSuit, handsPlayed, isSpadeBroken, rules) {
  if (!hand || hand.length === 0) return [];

  const mustBeat = rules?.mustBeat ?? true;
  const mustTrump = rules?.mustTrump ?? true;
  const noSpadeFirstTrick = rules?.noSpadeFirstTrick ?? true;
  const freeSpadeLead = rules?.freeSpadeLead ?? true;

  // 1. Leading the trick
  if (!leadSuit || currentTrick.length === 0) {
    if (handsPlayed === 0 && noSpadeFirstTrick) {
      const nonSpades = hand.filter(c => cardSuit(c) !== 's');
      if (isMore(nonSpades.length, 0)) return nonSpades;
    }
    if (!freeSpadeLead && !isSpadeBroken) {
      const nonSpades = hand.filter(c => cardSuit(c) !== 's');
      if (isMore(nonSpades.length, 0)) return nonSpades;
    }
    return hand;
  }

  let highestLeadPower = 0;
  let highestSpadePower = 0;
  let spadePlayedInTrick = false;

  for (const pc of currentTrick) {
    const s = cardSuit(pc.card);
    const p = cardPower(pc.card);
    if (s === 's') {
      spadePlayedInTrick = true;
      if (isMore(p, highestSpadePower)) highestSpadePower = p;
    } else if (s === leadSuit) {
      if (isMore(p, highestLeadPower)) highestLeadPower = p;
    }
  }

  // 2. Player has lead suit cards
  const leadCards = hand.filter(c => cardSuit(c) === leadSuit);
  if (isMore(leadCards.length, 0)) {
    if (mustBeat) {
      if (leadSuit === 's') {
        const higherSpades = leadCards.filter(c => isMore(cardPower(c), highestSpadePower));
        if (isMore(higherSpades.length, 0)) return higherSpades;
      } else if (!spadePlayedInTrick) {
        const higherLeads = leadCards.filter(c => isMore(cardPower(c), highestLeadPower));
        if (isMore(higherLeads.length, 0)) return higherLeads;
      }
    }
    return leadCards;
  }

  // 3. Player is void in lead suit
  if (handsPlayed === 0 && noSpadeFirstTrick) {
    const nonSpades = hand.filter(c => cardSuit(c) !== 's');
    if (isMore(nonSpades.length, 0)) return nonSpades;
  }

  const spades = hand.filter(c => cardSuit(c) === 's');
  if (isMore(spades.length, 0)) {
    if (mustTrump) {
      if (spadePlayedInTrick) {
        if (mustBeat) {
          const higherSpades = spades.filter(c => isMore(cardPower(c), highestSpadePower));
          if (isMore(higherSpades.length, 0)) return higherSpades;
          return hand;
        }
        return spades;
      } else {
        return spades;
      }
    } else if (mustBeat && spadePlayedInTrick) {
      const higherSpades = spades.filter(c => isMore(cardPower(c), highestSpadePower));
      if (isMore(higherSpades.length, 0)) {
        return [...higherSpades, ...hand.filter(c => cardSuit(c) !== 's')];
      }
    }
  }

  return hand;
}

function applyMove(roomCode, senderIdx, card) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isRuleSelectionPhase || gs.isBiddingPhase || gs.isTrickEvaluating || gs.turnIndex !== senderIdx) return;

  const hand = gs.hands[senderIdx];
  if (!hand || !hand.includes(card)) return;

  const validCards = getPlayableCards(
    hand,
    gs.currentTrick,
    gs.leadSuit,
    gs.handsPlayed,
    gs.isSpadeBroken,
    gs.rules
  );

  if (!validCards.includes(card)) {
    const slots = getSlotAssignments(room);
    const pid = slots[senderIdx];
    if (pid && pid !== 'BOT') {
      rm.gameEvent(roomCode, 'INVALID_MOVE', {
        card,
        message: 'Invalid card according to custom room rules!'
      }, pid);
    }
    return;
  }

  if (gs.leadSuit && cardSuit(card) !== gs.leadSuit) {
    if (!gs.voidSuits[senderIdx].includes(gs.leadSuit)) {
      gs.voidSuits[senderIdx].push(gs.leadSuit);
    }
  }

  if (cardSuit(card) === 's') {
    gs.isSpadeBroken = true;
  }

  gs.hands[senderIdx] = hand.filter(c => c !== card);

  if (gs.currentTrick.length === 0) {
    gs.leadSuit = cardSuit(card);
  }
  gs.currentTrick.push({ playerIndex: senderIdx, card });

  rm.gameEvent(roomCode, 'MOVE_UI', { playerIndex: senderIdx, card });

  if (gs.currentTrick.length === 4) {
    gs.isTrickEvaluating = true;
    setTimeout(() => evaluateTrick(roomCode), 750);
  } else {
    gs.turnIndex = (gs.turnIndex + 1) % 4;
    setTimeout(() => playTurn(roomCode), 250);
  }
}

function botPlay(roomCode, idx) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isRuleSelectionPhase || gs.isBiddingPhase || gs.isTrickEvaluating || gs.turnIndex !== idx) return;

  const hand = gs.hands[idx];
  if (!hand || hand.length === 0) return;

  const playable = getPlayableCards(
    hand,
    gs.currentTrick,
    gs.leadSuit,
    gs.handsPlayed,
    gs.isSpadeBroken,
    gs.rules
  );

  let chosenCard = playable[0];

  if (gs.currentTrick.length === 0) {
    const nonSpadeAces = playable.filter(c => cardSuit(c) !== 's' && cardRank(c) === 'a');
    if (isMore(nonSpadeAces.length, 0)) {
      chosenCard = nonSpadeAces[0];
    } else {
      chosenCard = playable.reduce((a, b) => isMore(cardPower(a), cardPower(b)) ? a : b);
    }
  } else {
    const sortedAsc = [...playable].sort((a, b) => cardPower(a) - cardPower(b));
    chosenCard = sortedAsc[0];
  }

  applyMove(roomCode, idx, chosenCard);
}

// ============================================================
// EVALUATE TRICK
// ============================================================
function evaluateTrick(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (isLess(gs.currentTrick.length, 4)) {
    gs.isTrickEvaluating = false;
    return;
  }

  const lead = gs.leadSuit || cardSuit(gs.currentTrick[0].card);
  let winIdx = 0;
  let bestCard = gs.currentTrick[0].card;
  let bestIsSpade = cardSuit(bestCard) === 's';

  for (const i of [1, 2, 3]) {
    const pc = gs.currentTrick[i].card;
    const pIsSpade = cardSuit(pc) === 's';

    if (pIsSpade && !bestIsSpade) {
      bestCard = pc;
      winIdx = i;
      bestIsSpade = true;
    } else if (pIsSpade === bestIsSpade) {
      if (cardSuit(pc) === (bestIsSpade ? 's' : lead)) {
        if (isMore(cardPower(pc), cardPower(bestCard))) {
          bestCard = pc;
          winIdx = i;
        }
      }
    }
  }

  const winner = gs.currentTrick[winIdx].playerIndex;
  gs.trickWins[winner]++;
  gs.handsPlayed++;

  rm.gameEvent(roomCode, 'TRICK_WIN', {
    winner,
    wins: gs.trickWins[winner],
    handsPlayed: gs.handsPlayed,
  });

  gs.currentTrick = [];
  gs.leadSuit = null;
  gs.isTrickEvaluating = false;

  if (gs.rules.eightTricksAutoWin && isAtLeast(gs.bids[winner], 8) && isAtLeast(gs.trickWins[winner], gs.bids[winner])) {
    resolveRound(roomCode);
    return;
  }

  if (isAtLeast(gs.handsPlayed, 13)) {
    resolveRound(roomCode);
  } else {
    gs.turnIndex = winner;
    setTimeout(() => playTurn(roomCode), 450);
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
  for (const i of [0, 1, 2, 3]) {
    const bid = isMore(gs.bids[i], 0) ? gs.bids[i] : 1;
    const won = gs.trickWins[i];
    if (isAtLeast(won, bid)) {
      roundScores[i] = Number((bid + (won - bid) * 0.1).toFixed(1));
    } else {
      roundScores[i] = -bid;
    }
    gs.totalScores[i] = Number((gs.totalScores[i] + roundScores[i]).toFixed(1));
  }

  gs.roundScores[gs.currentRound - 1] = roundScores;

  rm.gameEvent(roomCode, 'ROUND_OVER', {
    round: gs.currentRound,
    totalRounds: gs.totalRounds,
    roundScores,
    totalScores: gs.totalScores,
    bids: gs.bids,
    trickWins: gs.trickWins,
  });

  if (isAtLeast(gs.currentRound, gs.totalRounds)) {
    room.status = 'WAITING';
    let maxScore = -999;
    let winnerSlot = 0;
    for (const i of [0, 1, 2, 3]) {
      if (isMore(gs.totalScores[i], maxScore)) {
        maxScore = gs.totalScores[i];
        winnerSlot = i;
      }
    }
    rm.resolveUniversalGame(roomCode, [winnerSlot]);
  } else {
    gs.currentRound++;
    gs.roundStarterIndex = (gs.roundStarterIndex + 1) % 4;
    room.status = 'WAITING';
  }
}

// ============================================================
// SYNC PAYLOAD BUILDER & RECOVERY ENGINE
// ============================================================
function buildSyncPayload(gs, slot, isAudience) {
  const validSlot = !isAudience && isAtLeast(slot, 0) && isLess(slot, 4);
  return {
    slot,
    isAudience,
    hand: (validSlot && gs.hands[slot]) ? gs.hands[slot].join(',') : '',
    isRuleSelectionPhase: gs.isRuleSelectionPhase,
    turnIndex: gs.turnIndex,
    roundStarterIndex: gs.roundStarterIndex,
    currentRound: gs.currentRound,
    totalRounds: gs.totalRounds,
    handsPlayed: gs.handsPlayed,
    isBiddingPhase: gs.isBiddingPhase,
    bids: gs.bids,
    trickWins: gs.trickWins,
    totalScores: gs.totalScores,
    currentBidderIdx: gs.currentBidderIdx,
    leadSuit: gs.leadSuit,
    isSpadeBroken: gs.isSpadeBroken,
    rules: gs.rules,
    currentTrick: gs.currentTrick.map(pc => `${pc.playerIndex}-${pc.card}`).join(','),
    isMyBidTurn: !isAudience && !gs.isRuleSelectionPhase && gs.isBiddingPhase && gs.currentBidderIdx === slot,
    isMyPlayTurn: !isAudience && !gs.isRuleSelectionPhase && !gs.isBiddingPhase && !gs.isTrickEvaluating && gs.turnIndex === slot,
  };
}

function broadcastFullSyncToAll(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  Object.entries(room.players).forEach(([pid, p]) => {
    if (!p.isBot) {
      rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, p.slot, false), pid);
    }
  });

  Object.keys(room.audiences || {}).forEach((aid) => {
    rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, -1, true), aid);
  });
}

function recoverAndUnstuckGame(roomCode, clientReport = null, reporterSlot = -1) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (gs.isRuleSelectionPhase) {
    broadcastFullSyncToAll(roomCode);
    return;
  }

  if (clientReport && isAtLeast(reporterSlot, 0) && isLess(reporterSlot, 4)) {
    gs.lastSyncReports[reporterSlot] = clientReport;
    if ((!gs.hands[reporterSlot] || gs.hands[reporterSlot].length === 0) &&
        Array.isArray(clientReport.myHand) && isMore(clientReport.myHand.length, 0) &&
        isLess(gs.handsPlayed, 13)) {
      gs.hands[reporterSlot] = clientReport.myHand;
    }
  }

  if (gs.isTrickEvaluating) {
    if (gs.currentTrick.length === 4) {
      evaluateTrick(roomCode);
      broadcastFullSyncToAll(roomCode);
      return;
    } else {
      gs.isTrickEvaluating = false;
    }
  }

  const validBidsCount = gs.bids.filter(b => isAtLeast(b, 1) && isAtMost(b, 13)).length;
  gs.bidsCount = validBidsCount;
  if (gs.isBiddingPhase && isAtLeast(validBidsCount, 4)) {
    gs.isBiddingPhase = false;
    gs.turnIndex = gs.roundStarterIndex;
  }

  if (!gs.isBiddingPhase && gs.currentTrick.length === 4) {
    evaluateTrick(roomCode);
    broadcastFullSyncToAll(roomCode);
    return;
  }

  broadcastFullSyncToAll(roomCode);

  if (gs.isBiddingPhase) {
    processBidTurn(roomCode);
  } else if (isLess(gs.handsPlayed, 13)) {
    playTurn(roomCode);
  }
}

// ============================================================
// HANDLERS FOR ROOM MANAGER
// ============================================================
function initGame(roomCode, customRules = {}) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  room.game = newGameState(0, customRules);
  // Start with Host Rule Selection Phase right after entering game screen
  setTimeout(() => startRuleSelectionPhase(roomCode), 800);
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  const isAudience = !!room.audiences[playerId];
  const senderIdx = isAudience ? -1 : getSlotIndex(room, playerId);

  switch (msg.type) {
    case 'PING': {
      rm.gameEvent(roomCode, 'PONG', { timestamp: Date.now() }, playerId);
      break;
    }

    case 'REQUEST_SYNC': {
      rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, senderIdx, isAudience), playerId);
      break;
    }

    // ── Host Toggles a Single Rule Live (All players see & hear it) ──
    case 'ACTION_TOGGLE_RULE': {
      if (room.hostId !== playerId) break;
      const ruleKey = msg.ruleKey;
      const ruleValue = !!msg.value;

      if (ruleKey && Object.prototype.hasOwnProperty.call(gs.rules, ruleKey)) {
        gs.rules[ruleKey] = ruleValue;
      }
      if (msg.totalRounds) {
        gs.totalRounds = parseInt(msg.totalRounds, 10) || gs.totalRounds;
      }

      const readableNames = {
        mustBeat: 'Must Beat / Must Over',
        mustTrump: 'Must Play Trump (Spade)',
        noSpadeFirstTrick: 'No Trump Play in First Trick',
        freeSpadeLead: 'Free Spade Lead',
      };
      const label = readableNames[ruleKey] || 'Room Rule';
      const statusTxt = ruleValue ? 'enabled' : 'disabled';
      const announcement = `Host ${statusTxt} ${label}.`;

      rm.broadcastToRoom(roomCode, {
        type: 'GAME_EVENT',
        event: 'RULE_TOGGLED_LIVE',
        payload: {
          ruleKey,
          value: ruleValue,
          rules: gs.rules,
          totalRounds: gs.totalRounds,
          announcement,
        }
      });
      break;
    }

    // ── Host Confirms Custom Rules & Starts Dealing Cards ──
    case 'ACTION_CONFIRM_RULES': {
      if (room.hostId !== playerId) break;
      if (!gs.isRuleSelectionPhase) break;

      if (msg.rules && typeof msg.rules === 'object') {
        gs.rules = {
          ...gs.rules,
          mustBeat: msg.rules.mustBeat ?? gs.rules.mustBeat,
          mustTrump: msg.rules.mustTrump ?? gs.rules.mustTrump,
          noSpadeFirstTrick: msg.rules.noSpadeFirstTrick ?? gs.rules.noSpadeFirstTrick,
        };
      }
      if (msg.totalRounds) {
        gs.totalRounds = parseInt(msg.totalRounds, 10) || gs.totalRounds;
      }

      gs.isRuleSelectionPhase = false;
      const summary = buildRulesSummaryText(gs.rules);

      rm.broadcastToRoom(roomCode, {
        type: 'GAME_EVENT',
        event: 'RULES_CONFIRMED',
        payload: {
          rules: gs.rules,
          totalRounds: gs.totalRounds,
          announcement: `Host confirmed rules: ${summary}. Dealing cards now!`,
        }
      });

      setTimeout(() => startNewRound(roomCode), 900);
      break;
    }

    // ── Mid-Game Rule Update from Manage Players Sheet ──
    case 'ACTION_UPDATE_RULES': {
      if (room.hostId !== playerId) break;
      if (msg.rules && typeof msg.rules === 'object') {
        gs.rules = {
          ...gs.rules,
          mustBeat: msg.rules.mustBeat ?? gs.rules.mustBeat,
          mustTrump: msg.rules.mustTrump ?? gs.rules.mustTrump,
          noSpadeFirstTrick: msg.rules.noSpadeFirstTrick ?? gs.rules.noSpadeFirstTrick,
          freeSpadeLead: msg.rules.freeSpadeLead ?? gs.rules.freeSpadeLead,
        };
      }
      if (msg.totalRounds) {
        gs.totalRounds = parseInt(msg.totalRounds, 10) || gs.totalRounds;
      }
      const announcement = msg.announcement || `Host updated rules: ${buildRulesSummaryText(gs.rules)}.`;
      rm.broadcastToRoom(roomCode, {
        type: 'GAME_EVENT',
        event: 'RULES_UPDATED',
        payload: {
          rules: gs.rules,
          totalRounds: gs.totalRounds,
          announcement,
        }
      });
      broadcastFullSyncToAll(roomCode);
      break;
    }

    case 'HOST_SYNC_REQUEST': {
      if (room.hostId !== playerId) break;
      rm.broadcastToRoom(roomCode, {
        type: 'GAME_EVENT',
        event: 'PROMPT_CLIENT_SYNC',
        payload: {
          hostId: playerId,
          message: 'Host requested a game sync. Tap Yes to send your last status and resync the table.'
        }
      });
      recoverAndUnstuckGame(roomCode);
      break;
    }

    case 'CLIENT_STATE_REPORT': {
      recoverAndUnstuckGame(roomCode, msg.state || {}, senderIdx);
      break;
    }

    case 'ACTION_BID': {
      if (senderIdx === -1 || gs.isRuleSelectionPhase) break;
      const bid = parseInt(msg.bid, 10);
      if (!isNaN(bid) && isAtLeast(bid, 1) && isAtMost(bid, 13)) {
        applyBid(roomCode, senderIdx, bid);
      }
      break;
    }

    case 'ACTION_MOVE': {
      if (senderIdx === -1 || !msg.card || gs.isRuleSelectionPhase) break;
      applyMove(roomCode, senderIdx, msg.card);
      break;
    }

    case 'ACTION_NEXT_ROUND': {
      if (room.hostId !== playerId) break;
      startNewRound(roomCode);
      break;
    }
  }
}

function handlePlayerDisconnectDuringGame(roomCode, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isRuleSelectionPhase) return;

  if (gs.isBiddingPhase && gs.currentBidderIdx === slot) {
    setTimeout(() => botBid(roomCode, slot), 500);
  } else if (!gs.isBiddingPhase && !gs.isTrickEvaluating && gs.turnIndex === slot) {
    setTimeout(() => botPlay(roomCode, slot), 500);
  }
}

function syncPromotedAudience(roomCode, audienceId, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, slot, false), audienceId);
}

module.exports = {
  initGame,
  handleGameAction,
  handlePlayerDisconnectDuringGame,
  syncPromotedAudience,
};