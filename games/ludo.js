/**
 * Ludo — Core Logic Module
 * Path: games/ludo.js
 * =====================================================
 * লুডোর সমস্ত রুলস, গুটির মুভমেন্ট, কাটাকাটি, এবং বট লজিক এখানে রয়েছে।
 * অ্যাক্সেসিবিলিটি (TTS) এর জন্য সার্ভার থেকে স্পেসিফিক মেসেজ পাঠানো হবে।
 */

'use strict';

const rm = require('../roomManager');

// ── কনস্ট্যান্টস (হলুদের বদলে White) ──
const COLORS = ['Red', 'Blue', 'White', 'Green']; // Slot 0: Red, Slot 1: Blue, Slot 2: White, Slot 3: Green
const SAFE_ZONES = [0, 8, 13, 21, 26, 34, 39, 47]; // গ্লোবাল ট্র্যাক অনুযায়ী সেফ জোন

// প্রতিটি রঙের স্টার্টিং পজিশন (গ্লোবাল ট্র্যাক ০-৫১)
const START_POSITIONS = { 0: 0, 1: 13, 2: 26, 3: 39 };

// ============================================================
// GAME STATE FACTORY
// ============================================================
function newLudoState(playMode) {
  return {
    playMode: playMode, // 'individual' অথবা 'team'
    turnIndex: 0,
    diceValue: 0,
    consecutiveSixes: 0,
    hasRolled: false,
    winners: [],
    
    // প্রতিটি প্লেয়ারের ৪টি করে গুটি। pos: -1 মানে ঘরে (Home Base), pos: 57 মানে গন্তব্যে (Destination)
    tokens: [
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], // P0 (Red)
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], // P1 (Blue)
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], // P2 (White)
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], // P3 (Green)
    ],
  };
}

// ============================================================
// EXPORTED INTERFACES
// ============================================================
function initGame(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  
  // রুমের playMode অনুযায়ী লুডোর স্টেট তৈরি
  room.game = newLudoState(room.playMode); 
  
  rm.broadcastToRoom(roomCode, { 
    type: 'GAME_EVENT', 
    event: 'GAME_STARTED', 
    payload: { turnIndex: 0, playMode: room.playMode } 
  });

  setTimeout(() => {
    checkBotTurn(roomCode);
  }, 2000);
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  
  const isAudience = !!room.audiences[playerId];
  if (isAudience) return; // দর্শকরা খেলতে পারবে না

  const senderIdx = room.players[playerId] ? room.players[playerId].slot : -1;
  if (senderIdx === -1) return;

  switch (msg.type) {
    case 'ROLL_DICE':
      rollDice(roomCode, senderIdx);
      break;
    case 'MOVE_TOKEN':
      moveToken(roomCode, senderIdx, msg.tokenId);
      break;
    case 'REQUEST_SYNC':
      syncGameState(roomCode, playerId, senderIdx);
      break;
  }
}

// ============================================================
// CORE LOGIC
// ============================================================

function rollDice(roomCode, playerIdx) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;

  if (gs.turnIndex !== playerIdx || gs.hasRolled) return;

  const diceVal = Math.floor(Math.random() * 6) + 1; // ১ থেকে ৬
  gs.diceValue = diceVal;
  gs.hasRolled = true;

  if (diceVal === 6) {
    gs.consecutiveSixes++;
  } else {
    gs.consecutiveSixes = 0;
  }

  // ৩ বার ৬ উঠলে দান বাতিল
  if (gs.consecutiveSixes === 3) {
    gs.consecutiveSixes = 0;
    gs.hasRolled = false;
    
    const pName = getPlayerName(room, playerIdx);
    rm.gameEvent(roomCode, 'DICE_ROLLED', { diceValue: 6, msg: `${pName} rolled three 6s! Turn cancelled.` });
    
    changeTurn(roomCode);
    return;
  }

  const pName = getPlayerName(room, playerIdx);
  const ttsMsg = `${pName} rolled a ${diceVal}.`;
  
  rm.gameEvent(roomCode, 'DICE_ROLLED', { 
    diceValue: diceVal, 
    playerIdx: playerIdx,
    ttsMsg: ttsMsg 
  });

  // ভ্যালিড মুভ চেক করা
  const validMoves = getValidMoves(gs, playerIdx, diceVal);
  
  if (validMoves.length === 0) {
    // চালার কিছু নেই
    setTimeout(() => {
      rm.gameEvent(roomCode, 'NO_VALID_MOVE', { msg: 'No moves available.' });
      changeTurn(roomCode);
    }, 1500);
  } else if (validMoves.length === 1) {
    // একটিই অপশন থাকলে অটো-চাল
    setTimeout(() => {
      moveToken(roomCode, playerIdx, validMoves[0]);
    }, 1000);
  } else {
    // একাধিক অপশন থাকলে প্লেয়ারের উত্তরের অপেক্ষা
    if (isBot(room, playerIdx)) {
      setTimeout(() => {
        // বট র‍্যান্ডম একটি ভ্যালিড গুটি চালবে
        const randomToken = validMoves[Math.floor(Math.random() * validMoves.length)];
        moveToken(roomCode, playerIdx, randomToken);
      }, 1500);
    }
  }
}

function moveToken(roomCode, playerIdx, tokenId) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;

  if (gs.turnIndex !== playerIdx || !gs.hasRolled) return;

  const validMoves = getValidMoves(gs, playerIdx, gs.diceValue);
  if (!validMoves.includes(tokenId)) return;

  const token = gs.tokens[playerIdx].find(t => t.id === tokenId);
  const oldPos = token.pos;
  let newPos = -1;
  let eventType = 'TOKEN_MOVED';
  let ttsMsg = '';
  const colorName = COLORS[playerIdx]; // Red, Blue, White, Green

  if (oldPos === -1 && gs.diceValue === 6) {
    // গুটি ঘর থেকে বের হলো
    newPos = 0; // রিলেটিভ পজিশন ০
    token.pos = newPos;
    eventType = 'TOKEN_UNLOCKED';
    ttsMsg = `${colorName} token unlocked from base.`;
  } else {
    // গুটি সামনে এগোলো
    newPos = oldPos + gs.diceValue;
    token.pos = newPos;
    
    if (newPos === 57) {
      eventType = 'TOKEN_FINISHED';
      ttsMsg = `${colorName} token reached the destination!`;
    } else {
      ttsMsg = `${colorName} token moved ${gs.diceValue} steps.`;
    }
  }

  // কাটাকাটি চেক (শুধুমাত্র গ্লোবাল ট্র্যাকে, রিলেটিভ পজিশন ০-৫০ এর মধ্যে)
  let cutDetails = null;
  if (newPos >= 0 && newPos <= 50) {
    const globalPos = getGlobalPosition(playerIdx, newPos);
    if (!SAFE_ZONES.includes(globalPos)) {
      cutDetails = checkAndCutToken(gs, playerIdx, globalPos);
    }
  }

  if (cutDetails) {
    eventType = 'TOKEN_CUT';
    ttsMsg = `${colorName} cut a ${COLORS[cutDetails.victimIdx]} token!`;
  }

  rm.gameEvent(roomCode, eventType, {
    playerIdx,
    tokenId,
    newPos,
    diceValue: gs.diceValue,
    cutDetails,
    ttsMsg: ttsMsg
  });

  // গেম ওভার চেক
  if (checkWinCondition(gs, playerIdx)) {
    gs.winners.push(playerIdx);
    
    if (gs.winners.length === 3 || (gs.playMode === 'team' && checkTeamWin(gs))) {
       // গেম শেষ! এখানে আমরা সেন্ট্রাল এপিআই (roomManager) কে জানাবো ইকোনমি আপডেটের জন্য
       rm.gameEvent(roomCode, 'GAME_OVER', { winners: gs.winners });
       return;
    }
  }

  // ৬ উঠলে, গুটি কাটলে বা গুটি গন্তব্যে পৌঁছালে আরেকবার চালার সুযোগ
  if (gs.diceValue === 6 || cutDetails || newPos === 57) {
    gs.hasRolled = false;
    setTimeout(() => checkBotTurn(roomCode), 1000);
  } else {
    setTimeout(() => changeTurn(roomCode), 1000);
  }
}

// ── Helper Functions ──

function getValidMoves(gs, playerIdx, diceVal) {
  const valid = [];
  const tokens = gs.tokens[playerIdx];

  tokens.forEach(t => {
    if (t.pos === -1 && diceVal === 6) valid.push(t.id);
    else if (t.pos !== -1 && (t.pos + diceVal) <= 57) valid.push(t.id);
  });
  return valid;
}

function getGlobalPosition(playerIdx, relativePos) {
  if (relativePos < 0 || relativePos > 50) return -1;
  const start = START_POSITIONS[playerIdx];
  return (start + relativePos) % 52;
}

function checkAndCutToken(gs, attackerIdx, globalPos) {
  for (let i = 0; i < 4; i++) {
    if (i === attackerIdx) continue;
    
    // টিম মোডে পার্টনারের গুটি কাটা যাবে না
    if (gs.playMode === 'team' && (i % 2 === attackerIdx % 2)) continue;

    for (let t of gs.tokens[i]) {
      if (t.pos >= 0 && t.pos <= 50) {
        if (getGlobalPosition(i, t.pos) === globalPos) {
          t.pos = -1; // ভিকটিমকে ঘরে পাঠিয়ে দেওয়া হলো
          return { victimIdx: i, tokenId: t.id };
        }
      }
    }
  }
  return null;
}

function changeTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;

  gs.hasRolled = false;
  gs.consecutiveSixes = 0;
  
  do {
    gs.turnIndex = (gs.turnIndex + 1) % 4;
  } while (gs.winners.includes(gs.turnIndex)); // যে জিতেছে তার টার্ন স্কিপ হবে

  rm.gameEvent(roomCode, 'TURN_CHANGED', { turnIndex: gs.turnIndex });
  
  checkBotTurn(roomCode);
}

function checkBotTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (isBot(room, gs.turnIndex)) {
    setTimeout(() => {
      rollDice(roomCode, gs.turnIndex);
    }, 1500);
  }
}

function checkWinCondition(gs, playerIdx) {
  return gs.tokens[playerIdx].every(t => t.pos === 57);
}

function checkTeamWin(gs) {
  const team02Won = checkWinCondition(gs, 0) && checkWinCondition(gs, 2);
  const team13Won = checkWinCondition(gs, 1) && checkWinCondition(gs, 3);
  return team02Won || team13Won;
}

function isBot(room, playerIdx) {
  const pId = Object.keys(room.players).find(id => room.players[id].slot === playerIdx);
  return pId ? room.players[pId].isBot : false;
}

function getPlayerName(room, playerIdx) {
  const pId = Object.keys(room.players).find(id => room.players[id].slot === playerIdx);
  return pId ? room.players[pId].name : 'Bot';
}

function syncGameState(roomCode, playerId, slot) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;
  
  const syncData = {
    turnIndex: gs.turnIndex,
    tokens: gs.tokens,
    winners: gs.winners,
    playMode: gs.playMode
  };
  rm.gameEvent(roomCode, 'SYNC_STATE', syncData, playerId);
}

function handlePlayerDisconnectDuringGame(roomCode, slot) {
  checkBotTurn(roomCode);
}

module.exports = {
  initGame,
  handleGameAction,
  handlePlayerDisconnectDuringGame
};