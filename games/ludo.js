/**
 * Ludo — Core Logic Module
 * Path: games/ludo.js
 */

'use strict';

const rm = require('../roomManager');

const COLORS = ['Red', 'Blue', 'White', 'Green']; 
const SAFE_ZONES = [1, 9, 14, 22, 27, 35, 40, 48]; 
const START_POSITIONS = { 0: 1, 1: 14, 2: 27, 3: 40 };

// ফাস্ট এবং স্মুথ সার্ভার টাইমিং (মিলিসেকেন্ডে)
const DELAYS = {
  GAME_START: 800,
  DICE_ANIM: 450,
  TOKEN_MOVE: 450,
  TOKEN_CUT: 900,
  TURN_CHANGE: 300,
  NO_MOVE: 650,
  BOT_THINK: 650
};

function newLudoState(playMode) {
  return {
    playMode: playMode, 
    activePlayerCount: 4, 
    turnIndex: 0,
    turnStartTime: Date.now(), 
    isTurnTimedOut: false,
    pendingDice: [], 
    consecutiveSixes: 0,
    rollPhase: true, 
    winners: [],
    isProcessing: false,
    actionTimer: null,
    
    playerStats: [
        { turnsWithoutSix: 0 }, { turnsWithoutSix: 0 }, 
        { turnsWithoutSix: 0 }, { turnsWithoutSix: 0 }
    ],
    revengeActive: [false, false, false, false],
    skippedPlayers: [false, false, false, false], 
    playerPresence: { 0: 'online', 1: 'online', 2: 'online', 3: 'online' },

    tokens: [
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
      [{ id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }], 
    ],
  };
}

// ── TURN TIMER & FAST SERVER SCHEDULER ──
const turnTimers = new Map();

function clearAllTimers(roomCode, gs) {
  if (turnTimers.has(roomCode)) {
    clearTimeout(turnTimers.get(roomCode));
    turnTimers.delete(roomCode);
  }
  if (gs && gs.actionTimer) {
    clearTimeout(gs.actionTimer);
    gs.actionTimer = null;
  }
}

function startTurnTimer(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (turnTimers.has(roomCode)) clearTimeout(turnTimers.get(roomCode));
  
  gs.turnStartTime = Date.now();
  gs.isTurnTimedOut = false;

  const timer = setTimeout(() => {
    handleTurnTimeout(roomCode);
  }, 40000); // সবার জন্য ৪০ সেকেন্ড
  turnTimers.set(roomCode, timer);

  rm.gameEvent(roomCode, 'TIMER_STARTED', { 
    turnStartTime: gs.turnStartTime,
    isTurnTimedOut: false 
  });
}

function handleTurnTimeout(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
  // ৪০ সেকেন্ড শেষ হলে যদি বট হয় তবে বট চাল দিয়ে দেবে, কিন্তু মানুষ হলে অটোমেটিক টার্ন পরিবর্তন হবে না।
  // হোস্ট চাইলে চাল স্কিপ করতে পারবে বা প্লেয়ারকে ডিসকানেক্ট করতে পারবে।
  if (isBot(room, gs.turnIndex)) {
    checkBotTurn(roomCode);
    return;
  }

  gs.isTurnTimedOut = true;
  rm.gameEvent(roomCode, 'TURN_TIMEOUT', { 
    turnIndex: gs.turnIndex,
    isTurnTimedOut: true 
  });
}

function scheduleNextStep(roomCode, nextActionFn, delayMs = 450) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  clearAllTimers(roomCode, gs);

  if (nextActionFn) {
    gs.isProcessing = true;
    gs.actionTimer = setTimeout(() => {
      if (!rm.rooms.has(roomCode) || !room.game) return;
      gs.isProcessing = false;
      gs.actionTimer = null;
      nextActionFn();
    }, delayMs);
  } else {
    gs.isProcessing = false;
    if (isBot(room, gs.turnIndex)) {
      gs.actionTimer = setTimeout(() => {
        if (!rm.rooms.has(roomCode) || !room.game) return;
        gs.actionTimer = null;
        checkBotTurn(roomCode);
      }, DELAYS.BOT_THINK);
    } else {
      startTurnTimer(roomCode);
    }
  }
}

function initGame(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room) return;
  room.game = newLudoState(room.playMode); 
  
  let botCount = 1;
  const activeSlots = [];
  
  Object.keys(room.players).forEach(pid => {
      const s = room.players[pid].slot;
      activeSlots.push(s);
      if (room.players[pid].isBot) {
          room.players[pid].name = `Bot ${botCount}`;
          room.game.playerPresence[s] = 'bot';
          botCount++;
      } else {
          room.game.playerPresence[s] = 'online';
      }
  });

  room.game.activePlayerCount = activeSlots.length;

  for (let i = 0; i < 4; i++) {
      if (!activeSlots.includes(i)) {
          room.game.skippedPlayers[i] = true;
          room.game.tokens[i] = []; 
          room.game.playerPresence[i] = 'empty';
      }
  }

  if (room.game.skippedPlayers[room.game.turnIndex]) {
      let loopCount = 0;
      do {
          room.game.turnIndex = (room.game.turnIndex + 1) % 4;
          loopCount++;
          if (loopCount > 4) break;
      } while (room.game.skippedPlayers[room.game.turnIndex]);
  }

  rm.broadcastToRoom(roomCode, { 
    type: 'GAME_EVENT', 
    event: 'GAME_STARTED', 
    payload: { 
        turnIndex: room.game.turnIndex, 
        playMode: room.playMode, 
        players: room.players,
        skippedPlayers: room.game.skippedPlayers,
        playerPresence: room.game.playerPresence,
        isTurnTimedOut: false,
        expectedAction: 'ROLL',
        actionPlayerIdx: room.game.turnIndex
    } 
  });

  let nextAction = null;
  if (isBot(room, room.game.turnIndex)) {
      nextAction = () => rollDice(roomCode, room.game.turnIndex);
  }
  scheduleNextStep(roomCode, nextAction, DELAYS.GAME_START);
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
  let senderIdx = -1;
  const isAudience = !!room.audiences[playerId];
  
  if (!isAudience) {
      senderIdx = room.players[playerId] ? room.players[playerId].slot : -1;
  }

  if (msg.type === 'REQUEST_SYNC') {
      syncGameState(roomCode, playerId, senderIdx, isAudience);
      return;
  }
  
  if (msg.type === 'ACTION_CHAT') {
      if (isAudience) return;
      let senderName = 'Unknown';
      if (room.players[playerId]) senderName = room.players[playerId].name;
      
      rm.broadcastToRoom(roomCode, {
          type: 'GAME_EVENT',
          event: 'CHAT',
          payload: { senderName: senderName, message: msg.message }
      });
      return;
  }

  if (msg.type === 'SEND_EMOJI') {
      let senderName = 'Unknown';
      if (isAudience && room.audiences[playerId]) senderName = room.audiences[playerId].name;
      else if (room.players[playerId]) senderName = room.players[playerId].name;

      if (isAudience) {
          room.game.lastEmojiTime = room.game.lastEmojiTime || {};
          const now = Date.now();
          const lastTime = room.game.lastEmojiTime[playerId] || 0;
          if (now - lastTime < 120000) {
              return; 
          }
          room.game.lastEmojiTime[playerId] = now;
      }

      rm.broadcastToRoom(roomCode, { 
          type: 'GAME_EVENT', 
          event: 'EMOJI_SENT', 
          payload: { playerIdx: senderIdx, emojiId: msg.emojiId, senderName: senderName }
      });
      return; 
  }

  // ── হোস্ট কন্ট্রোল: ৪০ সেকেন্ড পর চাল পাস করা বা প্লেয়ারকে ডিসকানেক্ট করা ──
  if (msg.type === 'HOST_SKIP_TURN') {
      if (room.hostId !== playerId) return;
      const targetSlot = msg.targetSlot !== undefined ? Number(msg.targetSlot) : gs.turnIndex;
      if (gs.turnIndex === targetSlot && gs.isTurnTimedOut) {
          clearAllTimers(roomCode, gs);
          gs.isTurnTimedOut = false;
          const pName = getPlayerNameBySlot(room, targetSlot);
          rm.gameEvent(roomCode, 'HOST_ACTION_NOTICE', {
              action: 'SKIP_TURN',
              slot: targetSlot,
              playerName: pName
          });
          changeTurn(roomCode);
      }
      return;
  }

  if (msg.type === 'HOST_KICK_PLAYER') {
      if (room.hostId !== playerId) return;
      const targetSlot = Number(msg.targetSlot);
      if (isNaN(targetSlot) || targetSlot < 0 || targetSlot > 3) return;
      if (targetSlot === senderIdx) return; // হোস্ট নিজেকে কিক করতে পারবে না

      const targetPid = Object.keys(room.players).find(
          pid => room.players[pid].slot === targetSlot && !room.players[pid].isBot
      );
      if (!targetPid) return;

      const kickedName = room.players[targetPid].name;
      room.disconnectedPlayers = room.disconnectedPlayers || {};
      room.disconnectedPlayers[targetPid] = { slot: targetSlot, name: kickedName };
      delete room.players[targetPid];

      if (gs.playMode === 'team') {
          room.players[`BOT_${targetSlot}`] = { name: `Bot ${targetSlot + 1}`, slot: targetSlot, isBot: true };
          gs.playerPresence[targetSlot] = 'bot';
      } else {
          gs.skippedPlayers[targetSlot] = true;
          gs.tokens[targetSlot] = [];
          gs.playerPresence[targetSlot] = 'disconnected';
          const remainingActive = [0, 1, 2, 3].filter(i => !gs.skippedPlayers[i]).length;
          gs.activePlayerCount = Math.max(2, remainingActive);
      }

      rm.broadcastRoomUpdate(roomCode);
      rm.gameEvent(roomCode, 'PLAYER_KICKED_BY_HOST', {
          slot: targetSlot,
          playerName: kickedName,
          players: room.players,
          skippedPlayers: gs.skippedPlayers,
          playerPresence: gs.playerPresence
      });

      if (gs.turnIndex === targetSlot) {
          clearAllTimers(roomCode, gs);
          gs.isTurnTimedOut = false;
          if (gs.playMode === 'team') {
              scheduleNextStep(roomCode, () => checkBotTurn(roomCode), DELAYS.BOT_THINK);
          } else {
              changeTurn(roomCode);
          }
      }
      return;
  }

  if (isAudience || senderIdx === -1) return;

  switch (msg.type) {
    case 'ROLL_DICE': rollDice(roomCode, senderIdx); break;
    case 'MOVE_TOKEN': moveToken(roomCode, senderIdx, msg.tokenId, msg.diceValue, msg.ownerIdx); break;
    case 'AUDIO_DONE': 
      // সার্ভার এখন আর ক্লায়েন্টের অডিও শেষ হওয়ার জন্য গেম ব্লক করে রাখবে না
      break;
    case 'ACTION_AWAY':
      gs.playerPresence[senderIdx] = 'away';
      rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'PLAYER_AWAY', payload: { playerIdx: senderIdx, playerPresence: gs.playerPresence }});
      break;
    case 'ACTION_RETURN':
      gs.playerPresence[senderIdx] = 'online';
      rm.broadcastToRoom(roomCode, { type: 'GAME_EVENT', event: 'PLAYER_RETURN', payload: { playerIdx: senderIdx, playerPresence: gs.playerPresence }});
      break;
  }
}

function getPlayerNameBySlot(room, slot) {
  const pid = Object.keys(room.players).find(id => room.players[id].slot === slot);
  return pid ? room.players[pid].name : `Player ${slot + 1}`;
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
        
        let strikeZone = [];
        let distantEnemies = [];

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
           
           if (!isFinish && t.pos !== -1) {
               for(let i = 1; i <= 57; i++) {
                   if (t.pos + i <= 50) {
                       let gPos = getGlobalPosition(ownerIdx, t.pos + i);
                       if (!SAFE_ZONES.includes(gPos)) { 
                           let check = checkAndCutTokenSimulation(gs, ownerIdx, gPos);
                           if (check) {
                               if (i <= 6) {
                                   strikeZone.push(i);
                               } else {
                                   distantEnemies.push(i);
                               }
                           }
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
             strikeZone: strikeZone,
             enemiesAhead: distantEnemies
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
  if (!room || !room.game) return;
  const gs = room.game;

  if (gs.turnIndex !== playerIdx || !gs.rollPhase || gs.isProcessing) return;

  clearAllTimers(roomCode, gs);
  gs.isTurnTimedOut = false;

  let chance = Math.random();
  let diceVal = Math.floor(chance * 6) + 1; 

  const pStats = gs.playerStats[playerIdx];
  const hasRevenge = gs.revengeActive[playerIdx];

  if (hasRevenge) {
      diceVal = chance > 0.7 ? 6 : (Math.floor(chance * 5) + 1);
      gs.revengeActive[playerIdx] = false; 
  } else if (pStats.turnsWithoutSix >= 10) {
      diceVal = chance > 0.5 ? 6 : (Math.floor(chance * 5) + 1);
  } else if (pStats.turnsWithoutSix >= 6) {
      diceVal = chance > 0.5 ? 6 : (Math.floor(chance * 5) + 1);
  }

  if (diceVal === 6) pStats.turnsWithoutSix = 0;
  else pStats.turnsWithoutSix++;

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
      validMoves: [],
      expectedAction: 'NONE',
      actionPlayerIdx: playerIdx
    });

    scheduleNextStep(roomCode, () => changeTurn(roomCode), DELAYS.NO_MOVE);
    return;
  }
  
  let validMovesDetails = [];
  if (!gs.rollPhase) {
      validMovesDetails = getValidMovesDetails(gs, playerIdx);
  }

  let expectedAction = 'NONE';
  let nextAction = null;
  let stepDelay = DELAYS.DICE_ANIM;

  if (gs.rollPhase) {
      expectedAction = 'ROLL';
      if (isBot(room, playerIdx)) {
          nextAction = () => rollDice(roomCode, playerIdx);
          stepDelay = DELAYS.BOT_THINK;
      }
  } else if (validMovesDetails.length > 0) {
      expectedAction = validMovesDetails.length > 1 ? 'MOVE' : 'NONE';
      
      if (isBot(room, playerIdx) || validMovesDetails.length === 1) {
          nextAction = () => {
              const move = isBot(room, playerIdx) 
                  ? (validMovesDetails.find(m => m.isUnlock) || validMovesDetails.find(m => m.killVictimIdx !== -1) || validMovesDetails[0])
                  : validMovesDetails[0];
              moveToken(roomCode, playerIdx, move.tokenId, move.diceValue, move.ownerIdx);
          };
          stepDelay = isBot(room, playerIdx) ? DELAYS.BOT_THINK : DELAYS.DICE_ANIM;
      }
  } else {
      nextAction = () => {
        rm.gameEvent(roomCode, 'NO_VALID_MOVE', { playerIdx });
        scheduleNextStep(roomCode, () => changeTurn(roomCode), DELAYS.TURN_CHANGE);
      };
      stepDelay = DELAYS.NO_MOVE;
  }

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

  scheduleNextStep(roomCode, nextAction, stepDelay);
}

function moveToken(roomCode, playerIdx, tokenId, diceValue, ownerIdx) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
  if (gs.turnIndex !== playerIdx || gs.rollPhase || gs.pendingDice.length === 0 || gs.isProcessing) return;

  if (ownerIdx === undefined) ownerIdx = playerIdx;
  if (gs.playMode !== 'team' && ownerIdx !== playerIdx) return;
  if (gs.playMode === 'team' && ownerIdx !== playerIdx && ownerIdx !== (playerIdx + 2) % 4) return;

  const validMoves = getValidMovesDetails(gs, playerIdx);
  const move = validMoves.find(m => m.ownerIdx === ownerIdx && m.tokenId === tokenId && m.diceValue === diceValue);
  if (!move) return;

  clearAllTimers(roomCode, gs);
  gs.isTurnTimedOut = false;

  const diceIndex = gs.pendingDice.indexOf(diceValue);
  if (diceIndex > -1) {
    gs.pendingDice.splice(diceIndex, 1);
  }

  const token = gs.tokens[ownerIdx].find(t => t.id === tokenId);
  let eventType = 'TOKEN_MOVED';

  let isLuckyZoneHit = false;
  if (token.pos === 0 && diceValue === 5 && (tokenId === 0 || tokenId === 3)) {
      isLuckyZoneHit = true;
  }
  
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
      
      if (Math.random() < 0.20) gs.revengeActive[move.killVictimIdx] = true;
  }

  if (isLuckyZoneHit) {
      gs.rollPhase = true; 
      if (eventType === 'TOKEN_MOVED') eventType = 'LUCKY_ZONE_HIT';
  }

  if (move.isFinish) gs.rollPhase = true; 

  if (checkWinCondition(gs, ownerIdx)) {
    if (!gs.winners.includes(ownerIdx)) gs.winners.push(ownerIdx);
    
    if (gs.winners.length >= gs.activePlayerCount - 1 || (gs.playMode === 'team' && checkTeamWin(gs))) {
       rm.gameEvent(roomCode, 'TOKEN_FINISHED', { playerIdx, ownerIdx, tokenId, newPos: move.newPos, diceValue, cutDetails });
       scheduleNextStep(roomCode, () => {
         rm.gameEvent(roomCode, 'GAME_OVER', { winners: gs.winners });
         if (rm.resolveUniversalGame) {
           rm.resolveUniversalGame(roomCode, gs.winners);
         }
       }, DELAYS.TOKEN_MOVE);
       return;
    }
  }

  let remainingMoves = [];
  if (!gs.rollPhase && gs.pendingDice.length > 0) {
      remainingMoves = getValidMovesDetails(gs, playerIdx);
  }

  let expectedAction = 'NONE';
  let nextAction = null;
  let stepDelay = cutDetails ? DELAYS.TOKEN_CUT : DELAYS.TOKEN_MOVE;

  if (gs.rollPhase) {
      expectedAction = 'ROLL';
      if (isBot(room, playerIdx)) {
          nextAction = () => rollDice(roomCode, playerIdx);
          stepDelay = DELAYS.BOT_THINK;
      }
  } else if (remainingMoves.length > 0) {
      expectedAction = remainingMoves.length > 1 ? 'MOVE' : 'NONE';
      
      if (isBot(room, playerIdx) || remainingMoves.length === 1) {
          nextAction = () => {
              const nextMove = isBot(room, playerIdx) 
                  ? (remainingMoves.find(m => m.isUnlock) || remainingMoves.find(m => m.killVictimIdx !== -1) || remainingMoves[0])
                  : remainingMoves[0];
              moveToken(roomCode, playerIdx, nextMove.tokenId, nextMove.diceValue, nextMove.ownerIdx);
          };
          stepDelay = isBot(room, playerIdx) ? DELAYS.BOT_THINK : DELAYS.TOKEN_MOVE;
      }
  } else {
      nextAction = () => changeTurn(roomCode);
      stepDelay = cutDetails ? DELAYS.TOKEN_CUT : DELAYS.TURN_CHANGE;
  }

  rm.gameEvent(roomCode, eventType, { 
      playerIdx, 
      ownerIdx, 
      tokenId, 
      newPos: move.newPos, 
      diceValue, 
      cutDetails,
      isSafeZone: move.isSafeZone,
      pendingDice: gs.pendingDice,
      rollPhase: gs.rollPhase,
      validMoves: remainingMoves,
      expectedAction: expectedAction,
      actionPlayerIdx: playerIdx
  });

  scheduleNextStep(roomCode, nextAction, stepDelay);
}

function changeTurn(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  gs.pendingDice = [];
  gs.consecutiveSixes = 0;
  gs.rollPhase = true; 
  gs.isTurnTimedOut = false;
  
  let loopCount = 0;
  do { 
      gs.turnIndex = (gs.turnIndex + 1) % 4; 
      loopCount++;
      if(loopCount > 4) break; 
  } while (gs.winners.includes(gs.turnIndex) || gs.skippedPlayers[gs.turnIndex]);
  
  rm.gameEvent(roomCode, 'TURN_CHANGED', { 
      turnIndex: gs.turnIndex,
      isTurnTimedOut: false,
      expectedAction: 'ROLL',
      actionPlayerIdx: gs.turnIndex
  });

  let nextAction = null;
  if (isBot(room, gs.turnIndex)) {
      nextAction = () => rollDice(roomCode, gs.turnIndex);
  }

  scheduleNextStep(roomCode, nextAction, DELAYS.TURN_CHANGE);
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

function checkWinCondition(gs, playerIdx) { return gs.tokens[playerIdx].length > 0 && gs.tokens[playerIdx].every(t => t.pos === 57); }
function checkTeamWin(gs) { return (checkWinCondition(gs, 0) && checkWinCondition(gs, 2)) || (checkWinCondition(gs, 1) && checkWinCondition(gs, 3)); }
function isBot(room, playerIdx) {
  const pId = Object.keys(room.players).find(id => room.players[id].slot === playerIdx);
  return pId ? room.players[pId].isBot : false;
}

function syncGameState(roomCode, playerId, slot, isAudience) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;

  if (slot !== -1 && !isAudience) {
    gs.playerPresence[slot] = 'online';
  }

  const currentValidMoves = (!isAudience && slot === gs.turnIndex && !gs.rollPhase)
      ? getValidMovesDetails(gs, slot)
      : [];

  rm.gameEvent(roomCode, 'SYNC_STATE', {
    turnIndex: gs.turnIndex,
    turnStartTime: gs.turnStartTime,
    isTurnTimedOut: gs.isTurnTimedOut,
    tokens: gs.tokens,
    winners: gs.winners,
    playMode: gs.playMode,
    pendingDice: gs.pendingDice,
    rollPhase: gs.rollPhase,
    players: room.players, 
    skippedPlayers: gs.skippedPlayers,
    playerPresence: gs.playerPresence,
    validMoves: currentValidMoves,
    myPlayerIndex: slot,
    expectedAction: gs.rollPhase ? 'ROLL' : 'MOVE',
    actionPlayerIdx: gs.turnIndex,
    isAudience: isAudience !== undefined ? isAudience : false
  }, playerId);
}

function syncPromotedAudience(roomCode, audienceId, slot) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  
  room.game.skippedPlayers[slot] = false;
  room.game.playerPresence[slot] = 'online';
  if (room.game.tokens[slot].length === 0) {
    room.game.tokens[slot] = [
      { id: 0, pos: -1 }, { id: 1, pos: -1 }, { id: 2, pos: -1 }, { id: 3, pos: -1 }
    ];
  }
  
  syncGameState(roomCode, audienceId, slot, false);
}

function handlePlayerDisconnectDuringGame(roomCode, slot) {
    const room = rm.rooms.get(roomCode);
    if (!room || !room.game) return;
    const gs = room.game;

    if (gs.playMode === 'team') {
        gs.playerPresence[slot] = 'bot';
        checkBotTurn(roomCode);
    } else {
        // ৪০ সেকেন্ডের লজিক অনুযায়ী প্লেয়ারের নাম ও স্ট্যাটাস অফলাইন দেখানো হবে,
        // যাতে হোস্ট নিজে সিদ্ধান্ত নিতে পারে তাকে কিক করবে নাকি চাল পাস করবে।
        gs.playerPresence[slot] = 'disconnected';
        rm.gameEvent(roomCode, 'PLAYER_PRESENCE_UPDATED', {
            slot: slot,
            status: 'disconnected',
            playerPresence: gs.playerPresence
        });
    }
}

module.exports = { initGame, handleGameAction, handlePlayerDisconnectDuringGame, syncPromotedAudience };