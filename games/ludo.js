/**
 * Ludo — Core Logic Module
 * Path: games/ludo.js
 */

'use strict';

const rm = require('../roomManager');

const COLORS = ['Red', 'Blue', 'White', 'Green']; 
const SAFE_ZONES = [1, 9, 14, 22, 27, 35, 40, 48]; 
const START_POSITIONS = { 0: 1, 1: 14, 2: 27, 3: 40 };

function newLudoState(playMode) {
  return {
    playMode: playMode, 
    turnIndex: 0,
    turnStartTime: Date.now(), 
    pendingDice: [], 
    consecutiveSixes: 0,
    rollPhase: true, 
    winners: [],
    isWaitingForAudio: false, 
    pendingAction: null,      
    actionTimer: null,
    tokens: [
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
    ],
  };
}

// ── TURN TIMER & AUDIO SYNC LOGIC ──
const turnTimers = new Map();

function startTurnTimer(roomCode) {
  if (turnTimers.has(roomCode)) clearTimeout(turnTimers.get(roomCode));
  
  const room = rm.rooms.get(roomCode);
  if (room && room.game) {
    room.game.turnStartTime = Date.now();
  }
  const timer = setTimeout(() => {
    handleTurnTimeout(roomCode);
  }, 40000); 
  turnTimers.set(roomCode, timer);
}

function handleTurnTimeout(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
  rm.gameEvent(roomCode, 'TURN_TIMEOUT', { turnIndex: gs.turnIndex });
  changeTurn(roomCode);
}

function prepareStateForAudio(roomCode, pendingActionFn) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  
  if (turnTimers.has(roomCode)) clearTimeout(turnTimers.get(roomCode));
  if (room.game.actionTimer) clearTimeout(room.game.actionTimer);
  
  room.game.isWaitingForAudio = true;
  room.game.pendingAction = pendingActionFn || null;
  
  // সেফটি ফলব্যাক
  room.game.actionTimer = setTimeout(() => {
      forceAudioDone(roomCode);
  }, 6000);
}

function handleAudioDoneSignal(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game || !room.game.isWaitingForAudio) return; 
  forceAudioDone(roomCode);
}

function forceAudioDone(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  
  room.game.isWaitingForAudio = false;
  if (room.game.actionTimer) clearTimeout(room.game.actionTimer);

  if (room.game.pendingAction) {
      const fn = room.game.pendingAction;
      room.game.pendingAction = null;
      fn(); 
  } else {
      if (isBot(room, room.game.turnIndex)) {
          checkBotTurn(roomCode);
      } else {
          startTurnTimer(roomCode);
          rm.gameEvent(roomCode, 'TIMER_STARTED', { turnStartTime: room.game.turnStartTime });
      }
  }
}

function initGame(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  room.game = newLudoState(room.playMode); 
  
  let botCount = 1;
  Object.keys(room.players).forEach(pid => {
      if (room.players[pid].isBot) {
          room.players[pid].name = `Bot ${botCount}`;
          botCount++;
      }
  });

  let nextAction = null;
  if (isBot(room, room.game.turnIndex)) {
      nextAction = () => rollDice(roomCode, room.game.turnIndex);
  }
  prepareStateForAudio(roomCode, nextAction);

  rm.broadcastToRoom(roomCode, { 
    type: 'GAME_EVENT', 
    event: 'GAME_STARTED', 
    payload: { 
        turnIndex: 0, 
        playMode: room.playMode, 
        players: room.players,
        expectedAction: 'ROLL',
        actionPlayerIdx: 0
    } 
  });
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
    case 'AUDIO_DONE': 
      const isBotTurn = isBot(room, room.game.turnIndex);
      if (senderIdx === room.game.turnIndex || (isBotTurn && senderIdx === 0)) {
          handleAudioDoneSignal(roomCode);
      }
      break;
  }
}

function getGlobalPosition(playerIdx, relativePos) {
  if (relativePos < 0 || relativePos > 50) return -1;
  return ((START_POSITIONS[playerIdx] - 1 + relativePos) % 52) + 1;
}

function getValidMovesDetails(gs, playerIdx) {
  const details = [];
  let indices = [playerIdx];
  if (gs.playMode === 'team') indices.push((playerIdx + 2) % 4);

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
        let enemiesAhead = [];

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
           } else if (newPos > 50 && newPos <= 57) {
             isSafeZone = true;
           }
           
           if (!isFinish) {
               for(let i = 1; i <= 50; i++) {
                   if (newPos + i <= 50) {
                       let gPos = getGlobalPosition(ownerIdx, newPos + i);
                       if (!SAFE_ZONES.includes(gPos)) { 
                           let check = checkAndCutTokenSimulation(gs, ownerIdx, gPos);
                           if (check) enemiesAhead.push(i);
                       }
                   }
               }
           }

           details.push({
             ownerIdx: ownerIdx,
             tokenId: t.id,
             diceValue: diceVal,
             currentPos: t.pos,
             newPos: newPos,
             isUnlock: isUnlock,
             isFinish: isFinish,
             killVictimIdx: killVictimIdx,
             isSafeZone: isSafeZone,
             enemiesAhead: enemiesAhead
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
    
    prepareStateForAudio(roomCode, () => changeTurn(roomCode));

    rm.gameEvent(roomCode, 'DICE_ROLLED', { 
      diceValue: 6, 
      pendingDice: [],
      playerIdx: playerIdx,
      isCancelled: true, 
      rollPhase: gs.rollPhase,
      validMoves: [],
      expectedAction: 'NONE',
      actionPlayerIdx: playerIdx
    });
    return;
  }
  
  let validMovesDetails = [];
  if (!gs.rollPhase) {
      validMovesDetails = getValidMovesDetails(gs, playerIdx);
  }

  let expectedAction = 'NONE';
  let pendingAction = null;

  if (gs.rollPhase) {
      expectedAction = 'ROLL';
      if (isBot(room, playerIdx)) pendingAction = () => rollDice(roomCode, playerIdx);
  } else if (validMovesDetails.length > 0) {
      expectedAction = validMovesDetails.length > 1 ? 'MOVE' : 'NONE';
      
      // বট লজিক ফিক্সড: বটের একাধিক চাল থাকলেও সে বুদ্ধি করে গুটি বেছে নেবে
      if (isBot(room, playerIdx) || validMovesDetails.length === 1) {
          pendingAction = () => {
              const move = isBot(room, playerIdx) 
                  ? (validMovesDetails.find(m => m.isUnlock) || validMovesDetails.find(m => m.killVictimIdx !== -1) || validMovesDetails[0])
                  : validMovesDetails[0];
              moveToken(roomCode, playerIdx, move.tokenId, move.diceValue, move.ownerIdx);
          };
      }
  } else {
      pendingAction = () => {
        rm.gameEvent(roomCode, 'NO_VALID_MOVE', {});
        prepareStateForAudio(roomCode, () => changeTurn(roomCode));
      };
  }

  prepareStateForAudio(roomCode, pendingAction);

  rm.gameEvent(roomCode, 'DICE_ROLLED', { 
    diceValue: diceVal, 
    pendingDice: gs.pendingDice, 
    playerIdx: playerIdx,
    isCancelled: false,
    rollPhase: gs.rollPhase,
    validMoves: validMovesDetails,
    expectedAction: expectedAction,
    actionPlayerIdx: playerIdx
  });
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
       prepareStateForAudio(roomCode, () => rm.gameEvent(roomCode, 'GAME_OVER', { winners: gs.winners }));
       rm.gameEvent(roomCode, 'TOKEN_FINISHED', { playerIdx, ownerIdx, tokenId, newPos: move.newPos, diceValue, cutDetails });
       return;
    }
  }

  let remainingMoves = [];
  if (!gs.rollPhase && gs.pendingDice.length > 0) {
      remainingMoves = getValidMovesDetails(gs, playerIdx);
  }

  let expectedAction = 'NONE';
  let pendingAction = null;

  if (gs.rollPhase) {
      expectedAction = 'ROLL';
      if (isBot(room, playerIdx)) pendingAction = () => rollDice(roomCode, playerIdx);
  } else if (remainingMoves.length > 0) {
      expectedAction = remainingMoves.length > 1 ? 'MOVE' : 'NONE';
      
      // বট লজিক ফিক্সড
      if (isBot(room, playerIdx) || remainingMoves.length === 1) {
          pendingAction = () => {
              const nextMove = isBot(room, playerIdx) 
                  ? (remainingMoves.find(m => m.isUnlock) || remainingMoves.find(m => m.killVictimIdx !== -1) || remainingMoves[0])
                  : remainingMoves[0];
              moveToken(roomCode, playerIdx, nextMove.tokenId, nextMove.diceValue, nextMove.ownerIdx);
          };
      }
  } else {
      pendingAction = () => changeTurn(roomCode);
  }

  prepareStateForAudio(roomCode, pendingAction);

  rm.gameEvent(roomCode, eventType, { 
      playerIdx, 
      ownerIdx, 
      tokenId, 
      newPos: move.newPos, 
      diceValue, 
      cutDetails,
      pendingDice: gs.pendingDice,
      rollPhase: gs.rollPhase,
      validMoves: remainingMoves,
      expectedAction: expectedAction,
      actionPlayerIdx: playerIdx
  });
}

function changeTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  const gs = room.game;
  gs.pendingDice = [];
  gs.consecutiveSixes = 0;
  gs.rollPhase = true; 
  do { gs.turnIndex = (gs.turnIndex + 1) % 4; } while (gs.winners.includes(gs.turnIndex));
  
  let pendingAction = null;
  if (isBot(room, gs.turnIndex)) {
      pendingAction = () => rollDice(roomCode, gs.turnIndex);
  }

  prepareStateForAudio(roomCode, pendingAction);

  rm.gameEvent(roomCode, 'TURN_CHANGED', { 
      turnIndex: gs.turnIndex,
      expectedAction: 'ROLL',
      actionPlayerIdx: gs.turnIndex
  });
}

function checkBotTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  if (isBot(room, room.game.turnIndex)) {
      if (room.game.rollPhase) {
          rollDice(roomCode, room.game.turnIndex);
      } else {
          const validMoves = getValidMovesDetails(room.game, room.game.turnIndex);
          if (validMoves.length > 0) {
              const move = validMoves.find(m => m.isUnlock) || validMoves.find(m => m.killVictimIdx !== -1) || validMoves[0];
              moveToken(roomCode, room.game.turnIndex, move.tokenId, move.diceValue, move.ownerIdx);
          } else {
              changeTurn(roomCode);
          }
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
    turnStartTime: room.game.turnStartTime,
    tokens: room.game.tokens,
    winners: room.game.winners,
    playMode: room.game.playMode,
    pendingDice: room.game.pendingDice,
    rollPhase: room.game.rollPhase,
    players: room.players, 
    myPlayerIndex: slot,
    expectedAction: room.game.rollPhase ? 'ROLL' : 'MOVE',
    actionPlayerIdx: room.game.turnIndex
  }, playerId);
}

function handlePlayerDisconnectDuringGame(roomCode, slot) { checkBotTurn(roomCode); }

module.exports = { initGame, handleGameAction, handlePlayerDisconnectDuringGame };