/**
 * CallBreak — Core Logic Module
 * Path: games/callbreak.js
 * =====================================================
 * কলব্রেকের সমস্ত রুলস, বিডিং, ট্রিক ভ্যালিডেশন, স্মার্ট এআই বট,
 * হোস্ট সিঙ্ক রিকভারি এবং পিং/পং লজিক।
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

    // Host Custom Rules
    rules: {
      mustBeat: customRules.mustBeat ?? true,                   // Must Over / Must Beat current winning card
      mustTrump: customRules.mustTrump ?? true,                 // Must play Spade if void in lead suit
      noSpadeFirstTrick: customRules.noSpadeFirstTrick ?? true, // Cannot play Spade in the 1st trick
      freeSpadeLead: customRules.freeSpadeLead ?? true,         // Can lead with Spade after 1st trick
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

    trickWins: [0, 0, 0, 0],
    roundScores: [[0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0], [0,0,0,0]],
    totalScores: [0, 0, 0, 0],

    turnIndex: 0,
    isTrickEvaluating: false,
    voidSuits: [[], [], [], []], // স্মার্ট বটের মেমরি: কে কোন স্যুটে ভয়েড
    lastSyncReports: {},         // প্লেয়ারদের পাঠানো লাস্ট স্ট্যাটাস রিপোর্ট
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

function cardSuit(code) { return code ? code.split('_')[0] : ''; }
function cardRank(code) { return code ? code.split('_')[1] : ''; }
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

function getSlotIndex(room, playerId) {
  const p = room.players[playerId];
  return p ? p.slot : -1;
}

// ============================================================
// AUTO-REDEAL CHECK (No Spades OR No Face Cards A, K, Q, J)
// ============================================================
function getRedealReason(hands) {
  for (let i = 0; i < 4; i++) {
    const hand = hands[i];
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
  gs.currentRound = currentRound;
  gs.totalRounds = totalRounds;
  gs.totalScores = totalScores;
  gs.roundScores = roundScores;
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

  // কারো হাতে কোনো স্পেড বা ফেস কার্ড না থাকলে আবার রিডিল করবে
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
  for (let i = 0; i < 4; i++) {
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
// BIDDING PHASE (1 - 8)
// ============================================================
function processBidTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase) return;

  if (gs.bidsCount >= 4) {
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
    rm.gameEvent(roomCode, 'BID_REQ', {
      currentBidderIdx: gs.currentBidderIdx
    }, pid);
  }
}

function applyBid(roomCode, senderIdx, bid) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (!gs.isBiddingPhase || gs.currentBidderIdx !== senderIdx) return;

  gs.bids[senderIdx] = bid;
  gs.bidsCount = gs.bids.filter(b => b >= 1 && b <= 8).length;
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
  const highSpades = spades.filter(c => cardPower(c) >= 11).length;
  const extraSpades = Math.max(0, spades.length - 3);

  const estimated = Math.round(acesAndKings * 0.8 + highSpades * 0.9 + extraSpades * 0.7);
  const suggestedBid = Math.min(8, Math.max(1, estimated));

  applyBid(roomCode, idx, suggestedBid);
}

// ============================================================
// PLAY TURN & STRICT RULE VALIDATION
// ============================================================
function playTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isBiddingPhase || gs.isTrickEvaluating) return;

  rm.gameEvent(roomCode, 'TURN', { turnIndex: gs.turnIndex });

  const slots = getSlotAssignments(room);
  if (slots[gs.turnIndex] === 'BOT') {
    setTimeout(() => botPlay(roomCode, gs.turnIndex), 1000);
  }
}

/**
 * এই ফাংশনটি হোস্টের সেট করা রুলস অনুযায়ী প্লেয়ার বা বটের হাতের কোন কোন কার্ড খেলা বৈধ তা বের করে:
 * 1. noSpadeFirstTrick: প্রথম ট্রিকে স্পেড খেলা নিষেধ (যদি হাতে অন্য স্যুট থাকে)।
 * 2. mustBeat (Must Over): টেবিলের বর্তমান সবচেয়ে বড় কার্ডের চেয়ে বড় কার্ড থাকলে তা খেলতে হবে।
 * 3. mustTrump: লিড স্যুট না থাকলে স্পেড (Trump) খেলতে হবে।
 */
function getPlayableCards(hand, currentTrick, leadSuit, handsPlayed, isSpadeBroken, rules) {
  if (!hand || hand.length === 0) return [];

  const mustBeat = rules?.mustBeat ?? true;
  const mustTrump = rules?.mustTrump ?? true;
  const noSpadeFirstTrick = rules?.noSpadeFirstTrick ?? true;
  const freeSpadeLead = rules?.freeSpadeLead ?? true;

  // ── ১. ট্রিকের প্রথম কার্ড (Leading the Trick) ──
  if (!leadSuit || currentTrick.length === 0) {
    if (handsPlayed === 0 && noSpadeFirstTrick) {
      const nonSpades = hand.filter(c => cardSuit(c) !== 's');
      if (nonSpades.length > 0) return nonSpades;
    }
    if (!freeSpadeLead && !isSpadeBroken) {
      const nonSpades = hand.filter(c => cardSuit(c) !== 's');
      if (nonSpades.length > 0) return nonSpades;
    }
    return hand;
  }

  // বর্তমান ট্রিকে কে জিতছে এবং স্পেড কাটা হয়েছে কি না তা বের করা
  let highestLeadPower = 0;
  let highestSpadePower = 0;
  let spadePlayedInTrick = false;

  for (const pc of currentTrick) {
    const s = cardSuit(pc.card);
    const p = cardPower(pc.card);
    if (s === 's') {
      spadePlayedInTrick = true;
      if (p > highestSpadePower) highestSpadePower = p;
    } else if (s === leadSuit) {
      if (p > highestLeadPower) highestLeadPower = p;
    }
  }

  // ── ২. হাতে যদি লিড স্যুটের কার্ড থাকে (Must Follow Suit) ──
  const leadCards = hand.filter(c => cardSuit(c) === leadSuit);
  if (leadCards.length > 0) {
    if (mustBeat) {
      if (leadSuit === 's') {
        const higherSpades = leadCards.filter(c => cardPower(c) > highestSpadePower);
        if (higherSpades.length > 0) return higherSpades;
      } else if (!spadePlayedInTrick) {
        // এখনো কেউ স্পেড না মেরে থাকলে লিড স্যুটের বড় কার্ড দিতে হবে
        const higherLeads = leadCards.filter(c => cardPower(c) > highestLeadPower);
        if (higherLeads.length > 0) return higherLeads;
      }
    }
    return leadCards;
  }

  // ── ৩. হাতে লিড স্যুট নেই (Void in Lead Suit) ──
  // প্রথম ট্রিকে স্পেড খেলা নিষেধ থাকলে এবং হাতে অন্য কার্ড থাকলে স্পেড বাদ
  if (handsPlayed === 0 && noSpadeFirstTrick) {
    const nonSpades = hand.filter(c => cardSuit(c) !== 's');
    if (nonSpades.length > 0) return nonSpades;
  }

  const spades = hand.filter(c => cardSuit(c) === 's');
  if (spades.length > 0) {
    if (mustTrump) {
      if (spadePlayedInTrick) {
        if (mustBeat) {
          const higherSpades = spades.filter(c => cardPower(c) > highestSpadePower);
          if (higherSpades.length > 0) return higherSpades;
          // বড় স্পেড না থাকলে যেকোনো কার্ড (বা ছোট স্পেড) খেলতে পারবে
          return hand;
        }
        return spades;
      } else {
        // কেউ এখনো স্পেড মারেনি, তাই যেকোনো স্পেড মারলেই ট্রিক জিতবে
        return spades;
      }
    } else if (mustBeat && spadePlayedInTrick) {
      // mustTrump অফ কিন্তু কেউ যদি স্পেড প্রপোজ করে তবে বড় স্পেড দিতে হবে
      const higherSpades = spades.filter(c => cardPower(c) > highestSpadePower);
      if (higherSpades.length > 0) return [...higherSpades, ...hand.filter(c => cardSuit(c) !== 's')];
    }
  }

  return hand;
}

function applyMove(roomCode, senderIdx, card) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  if (gs.isBiddingPhase || gs.isTrickEvaluating || gs.turnIndex !== senderIdx) return;

  const hand = gs.hands[senderIdx];
  if (!hand || !hand.includes(card)) return;

  // সার্ভার-সাইড রুল ভ্যালিডেশন
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
        message: 'Invalid card according to room rules!'
      }, pid);
    }
    return;
  }

  // বটের মেমরির জন্য ভয়েড স্যুট ট্র্যাক করা
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
  if (gs.isBiddingPhase || gs.isTrickEvaluating || gs.turnIndex !== idx) return;

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
    // ১ম চাল: নন-স্পেড টেক্কা (Ace) থাকলে আগে খেলে হাত নিশ্চিত করবে
    const nonSpadeAces = playable.filter(c => cardSuit(c) !== 's' && cardRank(c) === 'a');
    if (nonSpadeAces.length > 0) {
      chosenCard = nonSpadeAces[0];
    } else {
      // অন্যথায় সবচেয়ে বড় পাওয়ারের নিরাপদ কার্ড খেলবে
      chosenCard = playable.reduce((a, b) => cardPower(a) > cardPower(b) ? a : b);
    }
  } else {
    // ট্রিকের মাঝখানে: যদি জিততে পারে তবে সবচেয়ে ছোট বিজয়ী কার্ডটি খেলবে, না পারলে সবচেয়ে ছোট কার্ড ফেলবে
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

  if (gs.currentTrick.length < 4) {
    gs.isTrickEvaluating = false;
    return;
  }

  const lead = gs.leadSuit || cardSuit(gs.currentTrick[0].card);
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

  rm.gameEvent(roomCode, 'TRICK_WIN', {
    winner,
    wins: gs.trickWins[winner],
    handsPlayed: gs.handsPlayed,
  });

  gs.currentTrick = [];
  gs.leadSuit = null;
  gs.isTrickEvaluating = false;

  // 8 Tricks Auto-Win Rule Check (যদি কেউ ৮ বিড করে ৮ হাত জিতে যায়)
  if (gs.rules.eightTricksAutoWin && gs.bids[winner] === 8 && gs.trickWins[winner] >= 8) {
    resolveRound(roomCode);
    return;
  }

  if (gs.handsPlayed >= 13) {
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
  for (let i = 0; i < 4; i++) {
    const bid = gs.bids[i] > 0 ? gs.bids[i] : 1;
    const won = gs.trickWins[i];
    if (won >= bid) {
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
  return {
    slot,
    isAudience,
    hand: (!isAudience && slot >= 0 && slot < 4 && gs.hands[slot]) ? gs.hands[slot].join(',') : '',
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
    isMyBidTurn: !isAudience && gs.isBiddingPhase && gs.currentBidderIdx === slot,
    isMyPlayTurn: !isAudience && !gs.isBiddingPhase && !gs.isTrickEvaluating && gs.turnIndex === slot,
  };
}

function broadcastFullSyncToAll(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  // সব প্লেয়ারকে তাদের নিজস্ব কার্ডসহ সিঙ্ক পাঠানো
  Object.entries(room.players).forEach(([pid, p]) => {
    if (!p.isBot) {
      rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, p.slot, false), pid);
    }
  });

  // সব দর্শককে সিঙ্ক পাঠানো
  Object.keys(room.audiences || {}).forEach((aid) => {
    rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, -1, true), aid);
  });
}

/**
 * সার্ভার কোনো কারণে আটকে গেলে প্লেয়ারদের রিপোর্ট দেখে আনস্টাক (Unstuck) করার ইঞ্জিন
 */
function recoverAndUnstuckGame(roomCode, clientReport = null, reporterSlot = -1) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  // যদি প্লেয়ারের রিপোর্ট থাকে এবং সার্ভারের ডেটা অমিল বা মিসিং থাকে তবে রিকভার করা
  if (clientReport && reporterSlot >= 0 && reporterSlot < 4) {
    gs.lastSyncReports[reporterSlot] = clientReport;

    // যদি কোনো কারণে সার্ভারে ওই প্লেয়ারের হাত খালি হয়ে গিয়ে থাকে কিন্তু ক্লায়েন্টে কার্ড থাকে
    if ((!gs.hands[reporterSlot] || gs.hands[reporterSlot].length === 0) &&
        Array.isArray(clientReport.myHand) && clientReport.myHand.length > 0 &&
        gs.handsPlayed < 13) {
      gs.hands[reporterSlot] = clientReport.myHand;
    }
  }

  // ১. ট্রিক মূল্যায়ন অবস্থায় আটকে থাকলে তা সমাধান করা
  if (gs.isTrickEvaluating) {
    if (gs.currentTrick.length === 4) {
      evaluateTrick(roomCode);
      broadcastFullSyncToAll(roomCode);
      return;
    } else {
      gs.isTrickEvaluating = false;
    }
  }

  // ২. বিডিং ফেজে সবাই বিড করা সত্ত্বেও আটকে থাকলে খেলা শুরু করে দেওয়া
  const validBidsCount = gs.bids.filter(b => b >= 1 && b <= 8).length;
  gs.bidsCount = validBidsCount;
  if (gs.isBiddingPhase && validBidsCount >= 4) {
    gs.isBiddingPhase = false;
    gs.turnIndex = gs.roundStarterIndex;
  }

  // ৩. ট্রিক ৪ কার্ড পূর্ণ হয়ে আটকে থাকলে মূল্যায়ন করা
  if (!gs.isBiddingPhase && gs.currentTrick.length === 4) {
    evaluateTrick(roomCode);
    broadcastFullSyncToAll(roomCode);
    return;
  }

  // ৪. সবাইকে সর্বশেষ সঠিক স্টেট ব্রডকাস্ট করা
  broadcastFullSyncToAll(roomCode);

  // ৫. বর্তমান টার্ন পুনরায় সচল করা (বিশেষ করে বট বা প্লেয়ারের টার্ন মিস হলে)
  if (gs.isBiddingPhase) {
    processBidTurn(roomCode);
  } else if (gs.handsPlayed < 13) {
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
  setTimeout(() => startNewRound(roomCode), 1500);
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  const isAudience = !!room.audiences[playerId];
  const senderIdx = isAudience ? -1 : getSlotIndex(room, playerId);

  switch (msg.type) {
    // ── প্রতি ৫ সেকেন্ডে সার্ভার Hot & Warm রাখার Ping/Pong ──
    case 'PING': {
      rm.gameEvent(roomCode, 'PONG', { timestamp: Date.now() }, playerId);
      break;
    }

    // ── সাধারণ সিঙ্ক রিকোয়েস্ট ──
    case 'REQUEST_SYNC': {
      rm.gameEvent(roomCode, 'SYNC_STATE', buildSyncPayload(gs, senderIdx, isAudience), playerId);
      break;
    }

    // ── হোস্ট কাস্টম রুলস আপডেট (Must Beat, Must Trump, No Spade in 1st Trick) ──
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
      rm.broadcastToRoom(roomCode, {
        type: 'GAME_EVENT',
        event: 'RULES_UPDATED',
        payload: { rules: gs.rules, totalRounds: gs.totalRounds }
      });
      broadcastFullSyncToAll(roomCode);
      break;
    }

    // ── হোস্টের "Sync Request" বাটন অ্যাকশন ──
    case 'HOST_SYNC_REQUEST': {
      if (room.hostId !== playerId) break;
      // সব প্লেয়ারকে মেসেজ পাঠানো যাতে তারা Yes বাটনে ক্লিক করে লাস্ট স্ট্যাটাস পাঠায়
      rm.broadcastToRoom(roomCode, {
        type: 'GAME_EVENT',
        event: 'PROMPT_CLIENT_SYNC',
        payload: {
          hostId: playerId,
          message: 'Host requested a game sync. Tap Yes to send your last status and resync the table.'
        }
      });
      // হোস্ট ক্লিক করার সাথে সাথেও একবার সার্ভার চেক করে নেবে
      recoverAndUnstuckGame(roomCode);
      break;
    }

    // ── প্লেয়াররা "Yes" বাটনে ক্লিক করলে লাস্ট স্ট্যাটাস রিপোর্ট গ্রহণ ও রিকভারি ──
    case 'CLIENT_STATE_REPORT': {
      recoverAndUnstuckGame(roomCode, msg.state || {}, senderIdx);
      break;
    }

    // ── বিড অ্যাকশন (1 - 8) ──
    case 'ACTION_BID': {
      if (senderIdx === -1) break;
      const bid = parseInt(msg.bid, 10);
      if (!isNaN(bid) && bid >= 1 && bid <= 8) {
        applyBid(roomCode, senderIdx, bid);
      }
      break;
    }

    // ── কার্ড খেলার অ্যাকশন ──
    case 'ACTION_MOVE': {
      if (senderIdx === -1 || !msg.card) break;
      applyMove(roomCode, senderIdx, msg.card);
      break;
    }

    // ── পরবর্তী রাউন্ড শুরু (হোস্ট) ──
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