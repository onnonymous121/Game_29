/**
 * Ludo — Core Logic Module
 * Path: games/ludo.js
 */

'use strict';

const rm = require('../roomManager');

const COLORS = ['Red', 'Blue', 'White', 'Green']; 
const SAFE_ZONES = [1, 9, 14, 22, 27, 35, 40, 48]; 
const START_POSITIONS = { 0: 1, 1: 14, 2: 27, 3: 40 };
const FINISH_POS = 56; // 51..55 হলো Safe 53..57 এবং 56 হলো 58 (Finish)

// প্রফেশনাল অ্যানিমেশন ও সাউন্ডের সাথে মিল রেখে সার্ভার টাইমিং (মিলিসেকেন্ডে)
const DELAYS = {
  GAME_START: 800,
  DICE_ANIM: 600,
  STEP_HOP: 165,
  TOKEN_MOVE: 450,
  TOKEN_CUT: 950,
  TURN_CHANGE: 350,
  NO_MOVE: 650,
  BOT_THINK: 650
};

function getMoveAnimDelay(diceVal, isUnlock, isCut) {
  const hops = isUnlock ? 1 : Math.max(1, Number(diceVal) || 1);
  const baseTime = (hops * DELAYS.STEP_HOP) + 280;
  return isCut ? Math.max(DELAYS.TOKEN_CUT, baseTime + 350) : Math.max(DELAYS.TOKEN_MOVE, baseTime);
}

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

function broadcastFullRoomSync(roomCode) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;

  Object.keys(room.players).forEach(pid => {
    const p = room.players[pid];
    if (!p.isBot) {
      syncGameState(roomCode, pid, p.slot, false);
    }
  });

  if (room.audiences) {
    Object.keys(room.audiences).forEach(aid => {
      syncGameState(roomCode, aid, -1, true);
    });
  }
}

function handleGameAction(roomCode, playerId, msg) {
  const room = rm.rooms.get(roomCode);
  if (!room || !room.game) return;
  const gs = room.game;
  
  let senderIdx = -1;
  const isAudience = !!(room.audiences && room.audiences[playerId]);
  
  if (!isAudience) {
      senderIdx = room.players[playerId] ? room.players[playerId].slot : -1;
      // কোনো ডিসকানেক্টেড বা অ্যাওয়ে প্লেয়ার কোনো অ্যাকশন পাঠালেই তার স্ট্যাটাস অনলাইন করে সবাইকে জানানো হবে
      if (senderIdx !== -1 && gs.playerPresence[senderIdx] !== 'online') {
          gs.playerPresence[senderIdx] = 'online';
          const pName = room.players[playerId] ? room.players[playerId].name : `Player ${senderIdx + 1}`;
          rm.gameEvent(roomCode, 'PLAYER_PRESENCE_UPDATED', {
              slot: senderIdx,
              status: 'online',
              playerName: pName,
              players: room.players,
              playerPresence: gs.playerPresence
          });
      }
  }

  if (msg.type === 'REQUEST_SYNC') {
      syncGameState(roomCode, playerId, senderIdx, isAudience);
      return;
  }

  if (msg.type === 'HOST_SYNC_REQUEST') {
      if (room.hostId !== playerId) return;
      broadcastFullRoomSync(roomCode);
      return;
  }

  if (msg.type === 'TOGGLE_VOICE_CALL') {
      if (room.hostId !== playerId) return;
      rm.gameEvent(roomCode, 'TOGGLE_VOICE_CALL', { isAllowed: !!msg.isAllowed });
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
      if (targetSlot === senderIdx) return;

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
      break;
    case 'ACTION_AWAY':
      gs.playerPresence[senderIdx] = 'away';
      rm.broadcastToRoom(roomCode, { 
        type: 'GAME_EVENT', 
        event: 'PLAYER_AWAY', 
        payload: { 
          slot: senderIdx,
          playerIdx: senderIdx, 
          playerName: getPlayerNameBySlot(room, senderIdx),
          playerPresence: gs.playerPresence 
        }
      });
      break;
    case 'ACTION_RETURN':
      gs.playerPresence[senderIdx] = 'online';
      rm.broadcastToRoom(roomCode, { 
        type: 'GAME_EVENT', 
        event: 'PLAYER_RETURN', 
        payload: { 
          slot: senderIdx,
          playerIdx: senderIdx, 
          playerName: getPlayerNameBySlot(room, senderIdx),
          playerPresence: gs.playerPresence 
        }
      });
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
        } else if (t.pos !== -1 && (t.pos + diceVal) <= FINISH_POS) {
          newPos = t.pos + diceVal;
          if (newPos === FINISH_POS) isFinish = true;
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
           } else if (newPos > 50 && newPos < FINISH_POS) {
             isSafeZone = true;
           }
           
           if (!isFinish && t.pos !== -1) {
               for(let i = 1; i <= FINISH_POS; i++) {
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

function buildFinalRankings(room, gs) {
  const rankings = [];
  if (gs.playMode === 'team') {
    const team0Won = checkWinCondition(gs, 0) && checkWinCondition(gs, 2);
    const winningSlots = team0Won ? [0, 2] : [1, 3];
    const losingSlots = team0Won ? [1, 3] : [0, 2];

    rankings.push({
      rank: 1,
      slots: winningSlots,
      name: `${getPlayerNameBySlot(room, winningSlots[0])} & ${getPlayerNameBySlot(room, winningSlots[1])}`
    });
    rankings.push({
      rank: 2,
      slots: losingSlots,
      name: `${getPlayerNameBySlot(room, losingSlots[0])} & ${getPlayerNameBySlot(room, losingSlots[1])}`
    });
  } else {
    const orderedSlots = [...gs.winners];
    for (let i = 0; i < 4; i++) {
      if (!gs.skippedPlayers[i] && !orderedSlots.includes(i)) {
        orderedSlots.push(i);
      }
    }
    orderedSlots.forEach((slot, idx) => {
      rankings.push({
        rank: idx + 1,
        slot: slot,
        name: getPlayerNameBySlot(room, slot)
      });
    });
  }
  return rankings;
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
  const oldPos = token.pos;
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

  const dynamicMoveDelay = getMoveAnimDelay(diceValue, move.isUnlock, !!cutDetails);

  if (checkWinCondition(gs, ownerIdx)) {
    if (!gs.winners.includes(ownerIdx)) gs.winners.push(ownerIdx);
    
    if (gs.winners.length >= gs.activePlayerCount - 1 || (gs.playMode === 'team' && checkTeamWin(gs))) {
       const finalRankings = buildFinalRankings(room, gs);
       rm.gameEvent(roomCode, 'TOKEN_FINISHED', { 
           playerIdx, 
           ownerIdx, 
           tokenId, 
           oldPos: oldPos,
           newPos: move.newPos, 
           diceValue, 
           cutDetails,
           isSafeZone: false
       });
       scheduleNextStep(roomCode, () => {
         clearAllTimers(roomCode, gs);
         rm.gameEvent(roomCode, 'GAME_OVER', {
           winners: gs.winners,
           rankings: finalRankings,
           playMode: gs.playMode
         });
         if (rm.resolveUniversalGame) {
           rm.resolveUniversalGame(roomCode, gs.winners);
         }
       }, dynamicMoveDelay);
       return;
    }
  }

  let remainingMoves = [];
  if (!gs.rollPhase && gs.pendingDice.length > 0) {
      remainingMoves = getValidMovesDetails(gs, playerIdx);
  }

  let expectedAction = 'NONE';
  let nextAction = null;
  let stepDelay = dynamicMoveDelay;

  if (gs.rollPhase) {
      expectedAction = 'ROLL';
      if (isBot(room, playerIdx)) {
          nextAction = () => rollDice(roomCode, playerIdx);
          stepDelay = dynamicMoveDelay + 300;
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
          stepDelay = dynamicMoveDelay + 250;
      }
  } else {
      nextAction = () => changeTurn(roomCode);
      stepDelay = dynamicMoveDelay;
  }

  rm.gameEvent(roomCode, eventType, { 
      playerIdx, 
      ownerIdx, 
      tokenId, 
      oldPos: oldPos,
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

function checkWinCondition(gs, playerIdx) { return gs.tokens[playerIdx].length > 0 && gs.tokens[playerIdx].every(t => t.pos === FINISH_POS); }
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
    const wasNotOnline = gs.playerPresence[slot] !== 'online';
    gs.playerPresence[slot] = 'online';

    // যদি প্লেয়ার আগে ডিসকানেক্টেড বা অ্যাওয়ে থাকে এবং এখন সিঙ্ক করে ফিরে আসে, তবে রুমের সবাইকে তার অনলাইন স্ট্যাটাস জানানো হবে
    if (wasNotOnline) {
      const pName = room.players[playerId] ? room.players[playerId].name : `Player ${slot + 1}`;
      rm.gameEvent(roomCode, 'PLAYER_PRESENCE_UPDATED', {
        slot: slot,
        status: 'online',
        playerName: pName,
        players: room.players,
        playerPresence: gs.playerPresence
      });
    }
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
  
  broadcastFullRoomSync(roomCode);
}

function handlePlayerDisconnectDuringGame(roomCode, slot) {
    const room = rm.rooms.get(roomCode);
    if (!room || !room.game) return;
    const gs = room.game;

    if (gs.playMode === 'team') {
        gs.playerPresence[slot] = 'bot';
        rm.gameEvent(roomCode, 'PLAYER_PRESENCE_UPDATED', {
            slot: slot,
            status: 'bot',
            playerPresence: gs.playerPresence
        });
        checkBotTurn(roomCode);
    } else {
        gs.playerPresence[slot] = 'disconnected';
        rm.gameEvent(roomCode, 'PLAYER_PRESENCE_UPDATED', {
            slot: slot,
            status: 'disconnected',
            playerPresence: gs.playerPresence
        });
    }
}

module.exports = { initGame, handleGameAction, handlePlayerDisconnectDuringGame, syncPromotedAudience };