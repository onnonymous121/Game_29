/**
 * Ludo — Core Logic Module
 * Path: games/ludo.js
 */

'use strict';

const rm = require('../roomManager');

const COLORS = ['Red', 'Blue', 'White', 'Green']; 
const SAFE_ZONES = [0, 8, 13, 21, 26, 34, 39, 47]; 
const START_POSITIONS = { 0: 0, 1: 13, 2: 26, 3: 39 };

function newLudoState(playMode) {
  return {
    playMode: playMode, 
    turnIndex: 0,
    diceValue: 0,
    consecutiveSixes: 0,
    hasRolled: false,
    winners: [],
    tokens: [
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
    ],
  };
}

function initGame(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  room.game = newLudoState(room.playMode); 
  rm.broadcastToRoom(roomCode, { 
    type: 'GAME_EVENT', 
    event: 'GAME_STARTED', 
    payload: { turnIndex: 0, playMode: room.playMode } 
  });
  setTimeout(() => checkBotTurn(roomCode), 2000);
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const isAudience = !!room.audiences[playerId];
  if (isAudience) return;

  const senderIdx = room.players[playerId] ? room.players[playerId].slot : -1;
  if (senderIdx === -1) return;

  switch (msg.type) {
    case 'ROLL_DICE': rollDice(roomCode, senderIdx); break;
    case 'MOVE_TOKEN': moveToken(roomCode, senderIdx, msg.tokenId); break;
    case 'REQUEST_SYNC': syncGameState(roomCode, playerId, senderIdx); break;
  }
}

// ── নতুন: Valid Moves Prediction Logic ──
function getValidMovesDetails(gs, playerIdx, diceVal) {
  const details = [];
  const tokens = gs.tokens[playerIdx];

  tokens.forEach(t => {
    let newPos = -1;
    let isUnlock = false;
    let isFinish = false;
    let killVictimIdx = -1;

    if (t.pos === -1 && diceVal === 6) {
      newPos = 0;
      isUnlock = true;
    } else if (t.pos !== -1 && (t.pos + diceVal) <= 57) {
      newPos = t.pos + diceVal;
      if (newPos === 57) isFinish = true;
    }

    if (newPos !== -1) {
       if (newPos >= 0 && newPos <= 50) {
         const globalPos = getGlobalPosition(playerIdx, newPos);
         if (!SAFE_ZONES.includes(globalPos)) {
           // ডেমো চেক: এই চালে কি কেউ কাটা পড়বে?
           const killDetails = checkAndCutTokenSimulation(gs, playerIdx, globalPos); 
           if (killDetails) killVictimIdx = killDetails.victimIdx;
         }
       }
       details.push({
         tokenId: t.id,
         currentPos: t.pos,
         newPos: newPos,
         isUnlock: isUnlock,
         isFinish: isFinish,
         killVictimIdx: killVictimIdx
       });
    }
  });
  return details;
}

// সিমুলেশন ফাংশন (আসল গুটি না কেটে শুধু চেক করবে)
function checkAndCutTokenSimulation(gs, attackerIdx, globalPos) {
  for (let i = 0; i < 4; i++) {
    if (i === attackerIdx) continue;
    if (gs.playMode === 'team' && (i % 2 === attackerIdx % 2)) continue;
    for (let t of gs.tokens[i]) {
      if (t.pos >= 0 && t.pos <= 50) {
        if (getGlobalPosition(i, t.pos) === globalPos) return { victimIdx: i, tokenId: t.id };
      }
    }
  }
  return null;
}

function rollDice(roomCode, playerIdx) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;

  if (gs.turnIndex !== playerIdx || gs.hasRolled) return;

  const diceVal = Math.floor(Math.random() * 6) + 1; 
  gs.diceValue = diceVal;
  gs.hasRolled = true;

  if (diceVal === 6) gs.consecutiveSixes++;
  else gs.consecutiveSixes = 0;

  if (gs.consecutiveSixes === 3) {
    gs.consecutiveSixes = 0;
    gs.hasRolled = false;
    const pName = getPlayerName(room, playerIdx);
    rm.gameEvent(roomCode, 'DICE_ROLLED', { diceValue: 6, validMoves: [], msg: `${pName} rolled three 6s! Turn cancelled.` });
    changeTurn(roomCode);
    return;
  }

  const pName = getPlayerName(room, playerIdx);
  const ttsMsg = `${pName} rolled a ${diceVal}.`;
  
  // প্রেডিকশন ডেটা তৈরি
  const validMovesDetails = getValidMovesDetails(gs, playerIdx, diceVal);
  
  rm.gameEvent(roomCode, 'DICE_ROLLED', { 
    diceValue: diceVal, 
    playerIdx: playerIdx,
    ttsMsg: ttsMsg,
    validMoves: validMovesDetails // ফ্রন্টএন্ডে পাঠানো হচ্ছে
  });

  if (validMovesDetails.length === 0) {
    setTimeout(() => {
      rm.gameEvent(roomCode, 'NO_VALID_MOVE', { msg: 'No moves available.' });
      changeTurn(roomCode);
    }, 1500);
  } else if (validMovesDetails.length === 1 && !isBot(room, playerIdx)) {
    // অ্যাক্সেসিবিলিটির জন্য অটো চাল বন্ধ করে ইউজারকে সিলেক্ট করতে দিতে পারেন, 
    // তবে গেম দ্রুত করার জন্য ১টা অপশন থাকলে সার্ভার অটো চালতে পারে। আমরা অটো চাল রাখছি।
    setTimeout(() => { moveToken(roomCode, playerIdx, validMovesDetails[0].tokenId); }, 1500);
  } else if (isBot(room, playerIdx)) {
    setTimeout(() => {
      const randomToken = validMovesDetails[Math.floor(Math.random() * validMovesDetails.length)].tokenId;
      moveToken(roomCode, playerIdx, randomToken);
    }, 1500);
  }
}

// আগের Move Token এবং কাটাকাটির ফাংশনগুলো ঠিক থাকবে...
function moveToken(roomCode, playerIdx, tokenId) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;
  if (gs.turnIndex !== playerIdx || !gs.hasRolled) return;

  const validMoves = getValidMovesDetails(gs, playerIdx, gs.diceValue).map(v => v.tokenId);
  if (!validMoves.includes(tokenId)) return;

  const token = gs.tokens[playerIdx].find(t => t.id === tokenId);
  const oldPos = token.pos;
  let newPos = -1;
  let eventType = 'TOKEN_MOVED';
  let ttsMsg = '';
  const colorName = COLORS[playerIdx];

  if (oldPos === -1 && gs.diceValue === 6) {
    newPos = 0; token.pos = newPos; eventType = 'TOKEN_UNLOCKED'; ttsMsg = `${colorName} token unlocked.`;
  } else {
    newPos = oldPos + gs.diceValue; token.pos = newPos;
    if (newPos === 57) { eventType = 'TOKEN_FINISHED'; ttsMsg = `${colorName} token reached destination!`; } 
    else { ttsMsg = `${colorName} token moved ${gs.diceValue} steps.`; }
  }

  let cutDetails = null;
  if (newPos >= 0 && newPos <= 50) {
    const globalPos = getGlobalPosition(playerIdx, newPos);
    if (!SAFE_ZONES.includes(globalPos)) cutDetails = checkAndCutToken(gs, playerIdx, globalPos);
  }

  if (cutDetails) {
    eventType = 'TOKEN_CUT';
    ttsMsg = `${colorName} cut a ${COLORS[cutDetails.victimIdx]} token!`;
  }

  rm.gameEvent(roomCode, eventType, { playerIdx, tokenId, newPos, diceValue: gs.diceValue, cutDetails, ttsMsg });

  if (checkWinCondition(gs, playerIdx)) {
    gs.winners.push(playerIdx);
    if (gs.winners.length === 3 || (gs.playMode === 'team' && checkTeamWin(gs))) {
       rm.gameEvent(roomCode, 'GAME_OVER', { winners: gs.winners });
       return;
    }
  }

  if (gs.diceValue === 6 || cutDetails || newPos === 57) {
    gs.hasRolled = false; setTimeout(() => checkBotTurn(roomCode), 1000);
  } else {
    setTimeout(() => changeTurn(roomCode), 1000);
  }
}

function getGlobalPosition(playerIdx, relativePos) {
  if (relativePos < 0 || relativePos > 50) return -1;
  const start = START_POSITIONS[playerIdx];
  return (start + relativePos) % 52;
}

function checkAndCutToken(gs, attackerIdx, globalPos) {
  for (let i = 0; i < 4; i++) {
    if (i === attackerIdx) continue;
    if (gs.playMode === 'team' && (i % 2 === attackerIdx % 2)) continue;
    for (let t of gs.tokens[i]) {
      if (t.pos >= 0 && t.pos <= 50) {
        if (getGlobalPosition(i, t.pos) === globalPos) {
          t.pos = -1; return { victimIdx: i, tokenId: t.id };
        }
      }
    }
  }
  return null;
}

function changeTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;
  gs.hasRolled = false; gs.consecutiveSixes = 0;
  do { gs.turnIndex = (gs.turnIndex + 1) % 4; } while (gs.winners.includes(gs.turnIndex));
  rm.gameEvent(roomCode, 'TURN_CHANGED', { turnIndex: gs.turnIndex });
  checkBotTurn(roomCode);
}

function checkBotTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  if (isBot(room, room.game.turnIndex)) setTimeout(() => { rollDice(roomCode, room.game.turnIndex); }, 1500);
}

function checkWinCondition(gs, playerIdx) { return gs.tokens[playerIdx].every(t => t.pos === 57); }
function checkTeamWin(gs) { return (checkWinCondition(gs, 0) && checkWinCondition(gs, 2)) || (checkWinCondition(gs, 1) && checkWinCondition(gs, 3)); }
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
  rm.gameEvent(roomCode, 'SYNC_STATE', {
    turnIndex: room.game.turnIndex,
    tokens: room.game.tokens,
    winners: room.game.winners,
    playMode: room.game.playMode,
    myPlayerIndex: slot
  }, playerId);
}

function handlePlayerDisconnectDuringGame(roomCode, slot) { checkBotTurn(roomCode); }

module.exports = { initGame, handleGameAction, handlePlayerDisconnectDuringGame };