/**
 * Ludo — Core Logic Module
 * Path: games/ludo.js
 */

'use strict';

const rm = require('../roomManager');

const COLORS = ['Red', 'Blue', 'White', 'Green']; 
// ── গ্লোবাল সেফ জোন (১ থেকে ৫২ এর ম্যাপ অনুযায়ী) ──
const SAFE_ZONES = [1, 9, 14, 22, 27, 35, 40, 48]; 
const START_POSITIONS = { 0: 1, 1: 14, 2: 27, 3: 40 };

function newLudoState(playMode) {
  return {
    playMode: playMode, 
    turnIndex: 0,
    pendingDice: [], 
    consecutiveSixes: 0,
    rollPhase: true, 
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
    payload: { turnIndex: 0, playMode: room.playMode, players: room.players } 
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
    case 'MOVE_TOKEN': moveToken(roomCode, senderIdx, msg.tokenId, msg.diceValue, msg.ownerIdx); break;
    case 'REQUEST_SYNC': syncGameState(roomCode, playerId, senderIdx); break;
  }
}

// ── গ্লোবাল পজিশন ক্যালকুলেটর (১ থেকে ৫২) ──
function getGlobalPosition(playerIdx, relativePos) {
  if (relativePos < 0 || relativePos > 50) return -1;
  // 1-based indexing math
  return ((START_POSITIONS[playerIdx] - 1 + relativePos) % 52) + 1;
}

// ── Valid Moves & Partner Token Logic ──
function getValidMovesDetails(gs, playerIdx) {
  const details = [];
  
  // নিজের এবং (টিম মোড হলে) পার্টনারের গুটিগুলোও চালার অপশনে যোগ করা
  let indices = [playerIdx];
  if (gs.playMode === 'team') {
      indices.push((playerIdx + 2) % 4);
  }

  const uniqueDice = [...new Set(gs.pendingDice)];

  indices.forEach(ownerIdx => {
    const tokens = gs.tokens[ownerIdx];
    tokens.forEach(t => {
      uniqueDice.forEach(diceVal => {
        let newPos = -1;
        let isUnlock = false;
        let isFinish = false;
        let killVictimIdx = -1;
        let isSafeZone = false;
        let enemyDistance = -1;

        if (t.pos === -1 && diceVal === 6) {
          newPos = 0;
          isUnlock = true;
        } else if (t.pos !== -1 && (t.pos + diceVal) <= 57) {
          newPos = t.pos + diceVal;
          if (newPos === 57) isFinish = true;
        }

        if (newPos !== -1) {
           if (newPos >= 0 && newPos <= 50) {
             const globalPos = getGlobalPosition(ownerIdx, newPos);
             
             if (SAFE_ZONES.includes(globalPos)) {
               isSafeZone = true; 
             } else {
               const killDetails = checkAndCutTokenSimulation(gs, ownerIdx, globalPos); 
               if (killDetails) killVictimIdx = killDetails.victimIdx;
             }
           }
           
           if (!isFinish) {
               for(let i = 1; i <= 6; i++) {
                   if (newPos + i <= 50) {
                       let gPos = getGlobalPosition(ownerIdx, newPos + i);
                       if (!SAFE_ZONES.includes(gPos)) { 
                           let check = checkAndCutTokenSimulation(gs, ownerIdx, gPos);
                           if (check) {
                               enemyDistance = i; 
                               break;
                           }
                       }
                   }
               }
           }

           details.push({
             ownerIdx: ownerIdx, // কার গুটি সেটা ট্র্যাক করা
             tokenId: t.id,
             diceValue: diceVal,
             currentPos: t.pos,
             newPos: newPos,
             isUnlock: isUnlock,
             isFinish: isFinish,
             killVictimIdx: killVictimIdx,
             isSafeZone: isSafeZone,
             enemyDistance: enemyDistance
           });
        }
      });
    });
  });
  return details;
}

function checkAndCutTokenSimulation(gs, attackerIdx, globalPos) {
  for (let i = 0; i < 4; i++) {
    if (i === attackerIdx) continue;
    if (gs.playMode === 'team' && (i % 2 === attackerIdx % 2)) continue; // টিমমেটকে কাটবে না
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

  if (gs.turnIndex !== playerIdx || !gs.rollPhase) return;

  const diceVal = Math.floor(Math.random() * 6) + 1; 
  gs.pendingDice.push(diceVal);

  if (diceVal === 6) {
    gs.consecutiveSixes++;
  } else {
    gs.consecutiveSixes = 0;
    gs.rollPhase = false; 
  }

  if (gs.consecutiveSixes === 3) {
    gs.consecutiveSixes = 0;
    gs.pendingDice = [];
    gs.rollPhase = false;
    rm.gameEvent(roomCode, 'DICE_ROLLED', { 
      diceValue: 6, 
      pendingDice: [],
      playerIdx: playerIdx,
      isCancelled: true, 
      rollPhase: gs.rollPhase,
      validMoves: [] 
    });
    setTimeout(() => changeTurn(roomCode), 1500);
    return;
  }
  
  let validMovesDetails = [];
  if (!gs.rollPhase) {
      validMovesDetails = getValidMovesDetails(gs, playerIdx);
  }

  rm.gameEvent(roomCode, 'DICE_ROLLED', { 
    diceValue: diceVal, 
    pendingDice: gs.pendingDice, 
    playerIdx: playerIdx,
    isCancelled: false,
    rollPhase: gs.rollPhase,
    validMoves: validMovesDetails 
  });

  if (!gs.rollPhase) {
      if (validMovesDetails.length === 0) {
        setTimeout(() => {
          rm.gameEvent(roomCode, 'NO_VALID_MOVE', {});
          changeTurn(roomCode);
        }, 1500);
      } else if (isBot(room, playerIdx)) {
        setTimeout(() => {
          const move = validMovesDetails[0]; 
          moveToken(roomCode, playerIdx, move.tokenId, move.diceValue, move.ownerIdx);
        }, 1500);
      }
  } else {
      if (isBot(room, playerIdx)) {
         setTimeout(() => { rollDice(roomCode, playerIdx); }, 1500);
      }
  }
}

function moveToken(roomCode, playerIdx, tokenId, diceValue, ownerIdx) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;
  
  if (gs.turnIndex !== playerIdx || gs.rollPhase || gs.pendingDice.length === 0) return;

  if (ownerIdx === undefined) ownerIdx = playerIdx;
  if (gs.playMode !== 'team' && ownerIdx !== playerIdx) return;
  if (gs.playMode === 'team' && ownerIdx !== playerIdx && ownerIdx !== (playerIdx + 2) % 4) return;

  const validMoves = getValidMovesDetails(gs, playerIdx);
  const move = validMoves.find(m => m.ownerIdx === ownerIdx && m.tokenId === tokenId && m.diceValue === diceValue);
  if (!move) return;

  const diceIndex = gs.pendingDice.indexOf(diceValue);
  if (diceIndex > -1) {
    gs.pendingDice.splice(diceIndex, 1);
  }

  const token = gs.tokens[ownerIdx].find(t => t.id === tokenId);
  let eventType = 'TOKEN_MOVED';
  
  if (move.isUnlock) {
      token.pos = 0;
      eventType = 'TOKEN_UNLOCKED';
  } else {
      token.pos = move.newPos;
      if (move.isFinish) eventType = 'TOKEN_FINISHED';
  }

  let cutDetails = null;
  if (move.killVictimIdx !== -1) {
      cutDetails = { victimIdx: move.killVictimIdx, tokenId: -1 }; 
      const globalPos = getGlobalPosition(ownerIdx, move.newPos);
      for (let t of gs.tokens[move.killVictimIdx]) {
          if (t.pos >= 0 && t.pos <= 50 && getGlobalPosition(move.killVictimIdx, t.pos) === globalPos) {
              t.pos = -1;
              cutDetails.tokenId = t.id;
              break;
          }
      }
      eventType = 'TOKEN_CUT';
      gs.rollPhase = true; 
  }

  if (move.isFinish) gs.rollPhase = true; 

  if (checkWinCondition(gs, ownerIdx)) {
    if (!gs.winners.includes(ownerIdx)) gs.winners.push(ownerIdx);
    if (gs.winners.length === 3 || (gs.playMode === 'team' && checkTeamWin(gs))) {
       rm.gameEvent(roomCode, 'TOKEN_FINISHED', { playerIdx, ownerIdx, tokenId, newPos: move.newPos, diceValue, cutDetails });
       setTimeout(() => rm.gameEvent(roomCode, 'GAME_OVER', { winners: gs.winners }), 1000);
       return;
    }
  }

  let remainingMoves = [];
  if (!gs.rollPhase && gs.pendingDice.length > 0) {
      remainingMoves = getValidMovesDetails(gs, playerIdx);
  }

  rm.gameEvent(roomCode, eventType, { 
      playerIdx, 
      ownerIdx, 
      tokenId, 
      newPos: move.newPos, 
      diceValue, 
      cutDetails,
      pendingDice: gs.pendingDice,
      rollPhase: gs.rollPhase,
      validMoves: remainingMoves
  });

  if (gs.rollPhase) {
      setTimeout(() => checkBotTurn(roomCode), 1000);
  } else if (gs.pendingDice.length > 0 && remainingMoves.length > 0) {
      if (isBot(room, playerIdx)) {
          setTimeout(() => {
              const nextMove = remainingMoves[0];
              moveToken(roomCode, playerIdx, nextMove.tokenId, nextMove.diceValue, nextMove.ownerIdx);
          }, 1500);
      }
  } else {
      setTimeout(() => changeTurn(roomCode), 1000);
  }
}

function changeTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;
  gs.pendingDice = [];
  gs.consecutiveSixes = 0;
  gs.rollPhase = true; 
  do { gs.turnIndex = (gs.turnIndex + 1) % 4; } while (gs.winners.includes(gs.turnIndex));
  rm.gameEvent(roomCode, 'TURN_CHANGED', { turnIndex: gs.turnIndex });
  checkBotTurn(roomCode);
}

function checkBotTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  if (isBot(room, room.game.turnIndex)) {
      if (room.game.rollPhase) {
          setTimeout(() => { rollDice(roomCode, room.game.turnIndex); }, 1500);
      }
  }
}

function checkWinCondition(gs, playerIdx) { return gs.tokens[playerIdx].every(t => t.pos === 57); }
function checkTeamWin(gs) { return (checkWinCondition(gs, 0) && checkWinCondition(gs, 2)) || (checkWinCondition(gs, 1) && checkWinCondition(gs, 3)); }
function isBot(room, playerIdx) {
  const pId = Object.keys(room.players).find(id => room.players[id].slot === playerIdx);
  return pId ? room.players[pId].isBot : false;
}

function syncGameState(roomCode, playerId, slot) {
  const room = rm.rooms.get(roomCode);
  rm.gameEvent(roomCode, 'SYNC_STATE', {
    turnIndex: room.game.turnIndex,
    tokens: room.game.tokens,
    winners: room.game.winners,
    playMode: room.game.playMode,
    pendingDice: room.game.pendingDice,
    rollPhase: room.game.rollPhase,
    players: room.players, // ইউজারের নাম ফ্রন্টএন্ডে পাঠানোর জন্য
    myPlayerIndex: slot
  }, playerId);
}

function handlePlayerDisconnectDuringGame(roomCode, slot) { checkBotTurn(roomCode); }

module.exports = { initGame, handleGameAction, handlePlayerDisconnectDuringGame };