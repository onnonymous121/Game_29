/**
 * Universal Room Manager
 * =====================================================
 * এটি সমস্ত গেমের (Game 29, Ludo, CallBreak) রুম কন্ট্রোল এবং সেন্ট্রাল ইকোনমি হ্যান্ডেল করবে।
 */

'use strict';

const express = require('express');
const { WebSocket } = require('ws');
const crypto = require('crypto');
const User = require('./models/User'); // ── ডাটাবেস মডেল ইমপোর্ট করা হলো ──

const router = express.Router();

// ============================================================
// IN-MEMORY STATE
// ============================================================
const rooms = new Map();
const connections = new Map();
const playerConnections = new Map();

module.exports.rooms = rooms;
module.exports.connections = connections;
module.exports.playerConnections = playerConnections;

// ============================================================
// GAME MODULES REGISTRY
// ============================================================
const game29Module = require('./games/game29');
const ludoModule = require('./games/ludo'); 

const AVAILABLE_GAMES = {
  '29': game29Module,
  'ludo': ludoModule, 
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function findFirstEmptySlot(players) {
  const occupied = Object.values(players).map(p => p.slot);
  for (let i = 0; i < 4; i++) if (!occupied.includes(i)) return i;
  return -1;
}

function getSlotIndex(room, playerId) {
  const p = room.players[playerId];
  return p ? p.slot : -1;
}

function sendToSocket(socketId, payload) {
  const conn = connections.get(socketId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(payload));
  }
}

function sendToPlayer(playerId, payload) {
  const sid = playerConnections.get(playerId);
  if (sid) sendToSocket(sid, payload);
}

function broadcastToRoom(roomCode, payload, excludePlayerId = null) {
  const raw = JSON.stringify(payload);
  connections.forEach((conn) => {
    if (conn.roomCode === roomCode && conn.playerId !== excludePlayerId) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(raw);
    }
  });
}

// ── প্লেয়ারদের বর্তমান অনলাইন/অফলাইন/অ্যাওয়ে স্ট্যাটাস বের করার হেল্পার ──
function buildPlayerPresence(room) {
  const presence = {};
  if (!room || !room.players) return presence;

  Object.entries(room.players).forEach(([pid, pData]) => {
    const slot = pData.slot;
    if (pData.isBot) {
      presence[slot] = 'bot';
      return;
    }
    const sid = playerConnections.get(pid);
    const conn = sid ? connections.get(sid) : null;
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      presence[slot] = 'disconnected';
    } else if (conn.isAway) {
      presence[slot] = 'away';
    } else {
      presence[slot] = 'online';
    }
  });
  return presence;
}

function broadcastRoomUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  broadcastToRoom(roomCode, {
    type: 'ROOM_UPDATE',
    roomCode,
    room: {
      hostId: room.hostId, hostName: room.hostName,
      status: room.status, type: room.type, 
      gameType: room.gameType, playMode: room.playMode, 
      allowAudience: room.allowAudience, sessionId: room.sessionId,
      players: room.players, requests: room.requests, audiences: room.audiences,
      playerPresence: buildPlayerPresence(room),
      prizePool: room.prizePool || 0 
    },
  });
}

function gameEvent(roomCode, event, payload, targetPlayerId = null) {
  const msg = { type: 'GAME_EVENT', event, payload: payload || {} };
  if (targetPlayerId) sendToPlayer(targetPlayerId, msg);
  else broadcastToRoom(roomCode, msg);
}

// ── ডিসকানেক্ট হওয়া প্লেয়ার ফিরে এলে বট সরিয়ে তার সিট ফিরিয়ে দেওয়ার হেল্পার (Auto-Revive) ──
function tryReviveDisconnectedPlayer(roomCode, room, playerId) {
  if (!room || !room.disconnectedPlayers || !room.disconnectedPlayers[playerId]) return false;
  const oldData = room.disconnectedPlayers[playerId];
  const slot = oldData.slot;
  const playerName = oldData.name;

  // যদি ওই স্লটে এখনো বট থাকে বা স্লটটি খালি থাকে
  const currentOccupantEntry = Object.entries(room.players).find(([, p]) => p.slot === slot);
  if (!currentOccupantEntry || currentOccupantEntry[1].isBot) {
    if (currentOccupantEntry) {
      delete room.players[currentOccupantEntry[0]];
    }
    room.players[playerId] = { name: playerName, slot: slot, isBot: false };
    delete room.disconnectedPlayers[playerId];
    room.emptySince = null;

    broadcastRoomUpdate(roomCode);
    gameEvent(roomCode, 'CHAT', {
      sender: 'SERVER',
      senderName: 'SERVER',
      message: `${playerName} rejoined the game and took back their seat.`
    });
    gameEvent(roomCode, 'PLAYER_REJOINED', { playerId, slot, playerName });

    const gameModule = AVAILABLE_GAMES[room.gameType];
    if (gameModule) {
      if (typeof gameModule.handlePlayerRejoinDuringGame === 'function') {
        gameModule.handlePlayerRejoinDuringGame(roomCode, playerId, slot, playerName);
      } else if (typeof gameModule.syncPromotedAudience === 'function') {
        gameModule.syncPromotedAudience(roomCode, playerId, slot);
      }
    }
    return true;
  }
  return false;
}

// ── Check if at least one real human player is online and active in the room ──
function hasActiveHumanPlayer(room) {
  if (!room || !room.players) return false;
  return Object.keys(room.players).some((pid) => {
    const p = room.players[pid];
    if (!p || p.isBot) return false;
    const sid = playerConnections.get(pid);
    if (!sid) return false;
    const conn = connections.get(sid);
    return conn && conn.ws && conn.ws.readyState === WebSocket.OPEN && !conn.isAway;
  });
}

// ── Update room activity status & track when it becomes empty of active humans ──
function updateRoomActivity(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (hasActiveHumanPlayer(room)) {
    room.emptySince = null;
  } else {
    if (!room.emptySince) {
      room.emptySince = Date.now();
    }
  }
}

// ── Background interval that deletes any room with no active human for > 5 minutes ──
const INACTIVE_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes
const AUDIENCE_CHAT_COOLDOWN_MS = 5 * 60 * 1000; // অডিয়েন্সের জন্য ৫ মিনিটে ১টি মেসেজ

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomCode) => {
    if (hasActiveHumanPlayer(room)) {
      room.emptySince = null;
    } else {
      if (!room.emptySince) {
        room.emptySince = now;
      } else if (now - room.emptySince >= INACTIVE_ROOM_TIMEOUT_MS) {
        broadcastToRoom(roomCode, {
          type: 'ROOM_DELETED',
          reason: 'No active human players for 5 minutes',
        });
        rooms.delete(roomCode);
      }
    }
  });
}, 15 * 1000); // প্রতি ১৫ সেকেন্ডে চেক করবে

module.exports.broadcastToRoom = broadcastToRoom;
module.exports.broadcastRoomUpdate = broadcastRoomUpdate;
module.exports.gameEvent = gameEvent;

// ============================================================
// UNIVERSAL ECONOMY LOGIC (Dynamic Leveling & Entry Fee)
// ============================================================

function getFeeBasedOnLevel(level) {
  if (level <= 20) return 150;        // Bronze
  else if (level <= 40) return 200;   // Silver
  else if (level <= 60) return 250;   // Gold
  else if (level <= 80) return 300;   // Platinum
  else if (level <= 100) return 350;  // Diamond
  else return 400;                    // Master (max 120)
}

function calculateDynamicLevel(xp) {
  return Math.min(120, Math.max(1, Math.floor(xp / 500) + 1));
}

async function resolveUniversalGame(roomCode, winnerSlotsArray) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const realPlayers = Object.keys(room.players).filter(pid => !room.players[pid].isBot);
  const winners = [];
  const losers = [];

  for (let pid of realPlayers) {
    if (winnerSlotsArray.includes(room.players[pid].slot)) {
      winners.push(pid);
    } else {
      losers.push(pid);
    }
  }

  const prizePool = room.prizePool || 0;
  const rewardPerWinner = winners.length > 0 ? Math.floor((prizePool * 0.95) / winners.length) : 0;

  const results = {};

  for (let pid of winners) {
    const user = await User.findOne({ uid: pid });
    if (user) {
      user.coins += rewardPerWinner;
      user.xp += 50;
      user.level = calculateDynamicLevel(user.xp);
      await user.save();
      results[pid] = { status: 'win', coinsEarned: rewardPerWinner, newCoins: user.coins, newLevel: user.level, xpChange: '+50' };
    }
  }

  for (let pid of losers) {
    const user = await User.findOne({ uid: pid });
    if (user) {
      user.xp = Math.max(0, user.xp - 20); 
      user.level = calculateDynamicLevel(user.xp);
      await user.save();
      results[pid] = { status: 'loss', coinsEarned: 0, newCoins: user.coins, newLevel: user.level, xpChange: '-20' };
    }
  }

  room.status = 'WAITING';
  room.prizePool = 0; 
  
  broadcastToRoom(roomCode, {
    type: 'GAME_OVER_RESULTS',
    results: results
  });
  broadcastRoomUpdate(roomCode);
  updateRoomActivity(roomCode);
}

module.exports.resolveUniversalGame = resolveUniversalGame;

// ============================================================
// HTTP REST API (Room CRUD & Lobby)
// ============================================================

router.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, connections: connections.size, uptime: Math.floor(process.uptime()) });
});

router.get('/rooms', (req, res) => {
  const list = [];
  const { gameType } = req.query; 

  rooms.forEach((room, code) => {
    if (room.type !== 'public') return;
    if (gameType && room.gameType !== gameType && gameType !== 'all') return; 

    // যদি ৫ মিনিটের বেশি সময় ধরে কোনো অ্যাক্টিভ হিউম্যান না থাকে, তবে লিস্টেও দেখাবে না এবং ডিলিট করে দেবে
    if (!hasActiveHumanPlayer(room) && room.emptySince && (Date.now() - room.emptySince >= INACTIVE_ROOM_TIMEOUT_MS)) {
      rooms.delete(code);
      return;
    }

    const playerCount = Object.keys(room.players).length;
    const canJoin = (room.status === 'WAITING' && (playerCount < 4 || room.allowAudience))
                 || (room.status === 'PLAYING' && room.allowAudience);
                 
    if (canJoin) {
      list.push({ 
        code, 
        hostName: room.hostName, 
        playerCount, 
        allowsAudience: room.allowAudience, 
        status: room.status,
        gameType: room.gameType,
        playMode: room.playMode
      });
    }
  });
  res.json(list);
});

router.get('/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: req.params.code, hostId: room.hostId, hostName: room.hostName,
    status: room.status, type: room.type, allowAudience: room.allowAudience,
    gameType: room.gameType, playMode: room.playMode, sessionId: room.sessionId, 
    playerCount: Object.keys(room.players).length,
    players: room.players, requests: room.requests, audiences: room.audiences,
    playerPresence: buildPlayerPresence(room),
  });
});

router.post('/rooms/create', (req, res) => {
  const { playerId, playerName, type, allowAudience, gameType, playMode } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  rooms.forEach((r, code) => { if (r.hostId === playerId) rooms.delete(code); });

  const roomCode = generateRoomCode();
  const finalGameType = gameType || '29'; 
  const finalPlayMode = playMode || (finalGameType === '29' ? 'team' : 'individual'); 

  // ডিফল্টভাবে হোস্ট সবসময় স্লট ১ (index 0)-এ থাকবে
  rooms.set(roomCode, {
    hostId: playerId, hostName: playerName,
    status: 'WAITING',
    type: type === 'private' ? 'private' : 'public',
    gameType: finalGameType, 
    playMode: finalPlayMode,
    allowAudience: allowAudience !== false,
    sessionId: null, createdAt: Date.now(),
    emptySince: null,
    players: { [playerId]: { name: playerName, slot: 0, isBot: false } },
    requests: {}, audiences: {},
    audienceChatTimestamps: {},
    game: null,
    disconnectedPlayers: {},
    disconnectTimers: {},
    prizePool: 0, 
  });
  res.json({ success: true, roomCode, gameType: finalGameType, playMode: finalPlayMode });
});

router.post('/rooms/:code/join', (req, res) => {
  const { playerId, playerName, asAudience } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // যদি এই প্লেয়ারের কোনো ডিসকানেক্ট টাইমার চলে থাকে, তা বাতিল করা হলো
  if (room.disconnectTimers && room.disconnectTimers[playerId]) {
    clearTimeout(room.disconnectTimers[playerId]);
    delete room.disconnectTimers[playerId];
  }

  // যদি প্লেয়ার ইতিমধ্যে রুমের প্লেয়ার লিস্টে থাকে (যেমন অ্যাপ মিনিমাইজ করে আবার জয়েন কল করলে)
  if (room.players[playerId] && !asAudience) {
    room.players[playerId].name = playerName;
    room.emptySince = null;
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'player', reason: 'already_in_room', gameType: room.gameType, playMode: room.playMode });
  }

  // ডিসকানেক্ট হওয়া প্লেয়ার ফিরে এলে সিট ফিরিয়ে দেওয়া
  if (tryReviveDisconnectedPlayer(req.params.code, room, playerId)) {
    return res.json({ role: 'player', reason: 'rejoined', gameType: room.gameType, playMode: room.playMode });
  }

  if (asAudience) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Audience not allowed' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', gameType: room.gameType, playMode: room.playMode });
  }

  if (room.status === 'PLAYING') {
    if (!room.allowAudience) return res.status(403).json({ error: 'Game in progress' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'game_started', gameType: room.gameType, playMode: room.playMode });
  }

  if (Object.keys(room.players).length >= 4) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Room full' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'room_full', gameType: room.gameType, playMode: room.playMode });
  }

  room.requests[playerId] = { name: playerName };
  broadcastRoomUpdate(req.params.code);
  res.json({ role: 'requested', gameType: room.gameType, playMode: room.playMode });
});

// ── নির্দিষ্ট স্লটে (যেমন ২ নম্বর খালি রেখে ৩ নম্বর স্লটে) প্লেয়ার অ্যাসাইন করার আপডেট ──
router.post('/rooms/:code/admit', (req, res) => {
  const { hostId, playerId, slot: requestedSlot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const req2 = room.requests[playerId] || room.audiences[playerId];
  if (!req2) return res.status(404).json({ error: 'Request not found' });

  let assignedSlot = -1;
  if (requestedSlot !== undefined && requestedSlot !== null) {
    const parsedSlot = Number(requestedSlot);
    if (parsedSlot >= 0 && parsedSlot < 4) {
      // যদি ওই স্লটে কোনো বট থাকে তবে বট সরিয়ে প্লেয়ার বসবে, আর রিয়েল প্লেয়ার থাকলে এরর দেবে
      const existingEntry = Object.entries(room.players).find(([, p]) => p.slot === parsedSlot);
      if (!existingEntry) {
        assignedSlot = parsedSlot;
      } else if (existingEntry[1].isBot) {
        delete room.players[existingEntry[0]];
        assignedSlot = parsedSlot;
      }
    }
  }

  if (assignedSlot === -1) {
    assignedSlot = findFirstEmptySlot(room.players);
  }
  if (assignedSlot === -1) return res.status(400).json({ error: 'Room full or slot occupied' });

  delete room.requests[playerId];
  delete room.audiences[playerId];
  room.players[playerId] = { name: req2.name, slot: assignedSlot, isBot: false };

  const sid = playerConnections.get(playerId);
  if (sid) {
    const conn = connections.get(sid);
    if (conn) conn.isAudience = false;
  }

  updateRoomActivity(req.params.code);
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true, slot: assignedSlot });
});

router.post('/rooms/:code/reject', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  delete room.requests[playerId];
  const sid = playerConnections.get(playerId);
  if (sid) sendToSocket(sid, { type: 'REJECTED' });
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ── হোস্ট কর্তৃক অ্যাসাইন করা প্লেয়ারকে স্লট থেকে সরানো (Unassign করে অপেক্ষমান তালিকায় পাঠানো বা রুম থেকে কিক করা) ──
router.post('/rooms/:code/remove_player', (req, res) => {
  const { hostId, targetPlayerId, moveToRequests } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });
  if (targetPlayerId === hostId) return res.status(400).json({ error: 'Host cannot remove themselves' });

  const pData = room.players[targetPlayerId];
  if (!pData) return res.status(404).json({ error: 'Player not found in slot' });

  delete room.players[targetPlayerId];

  if (moveToRequests && !pData.isBot) {
    room.requests[targetPlayerId] = { name: pData.name };
    sendToPlayer(targetPlayerId, { type: 'UNASSIGNED_TO_REQUESTS' });
  } else if (!pData.isBot) {
    sendToPlayer(targetPlayerId, { type: 'KICKED_BY_HOST' });
  }

  updateRoomActivity(req.params.code);
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ── হোস্ট কর্তৃক নির্দিষ্ট অডিয়েন্সকে রিমুভ করা ──
router.post('/rooms/:code/kick_audience', (req, res) => {
  const { hostId, audienceId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  if (room.audiences[audienceId]) {
    delete room.audiences[audienceId];
    sendToPlayer(audienceId, { type: 'KICKED_BY_HOST', reason: 'Removed from audience by host' });
    broadcastRoomUpdate(req.params.code);
  }
  res.json({ success: true });
});

// ── হোস্ট কর্তৃক যেকোনো সময় অডিয়েন্স দেখা চালু বা বন্ধ করা ──
router.post('/rooms/:code/toggle_audience', (req, res) => {
  const { hostId, allowAudience } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  room.allowAudience = Boolean(allowAudience);

  // যদি অডিয়েন্স বন্ধ করে দেওয়া হয়, তবে বর্তমান সকল অডিয়েন্সকে রুম থেকে বের করে দেওয়া হবে
  if (!room.allowAudience && room.audiences) {
    Object.keys(room.audiences).forEach((aid) => {
      sendToPlayer(aid, { type: 'AUDIENCE_DISABLED', reason: 'Host disabled audience viewing' });
    });
    room.audiences = {};
  }

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true, allowAudience: room.allowAudience });
});

// ── START GAME: ENTRY FEE DEDUCTION LOGIC ──
router.post('/rooms/:code/start', async (req, res) => {
  const { hostId, sessionId } = req.body;
  const room = rooms.get(req.params.code);
  
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const realPlayers = Object.keys(room.players).filter(pid => !room.players[pid].isBot);
  let totalPrizePool = 0;
  const playerUpdates = [];

  for (let pid of realPlayers) {
    const user = await User.findOne({ uid: pid });
    if (!user) continue;
    
    const level = user.level || 1;
    const requiredFee = getFeeBasedOnLevel(level);

    if (user.coins < requiredFee) {
      return res.status(400).json({ 
        error: `Insufficient coins for player: ${room.players[pid].name}. Need ${requiredFee} coins.`,
        errorCode: 'INSUFFICIENT_COINS' 
      });
    }

    playerUpdates.push({ user, fee: requiredFee });
  }

  for (let { user, fee } of playerUpdates) {
    user.coins -= fee;
    await user.save();
    totalPrizePool += fee;
  }

  room.prizePool = totalPrizePool; 

  const sid = sessionId || crypto.randomUUID();
  room.sessionId = sid;
  room.status = 'PLAYING';
  updateRoomActivity(req.params.code);
  broadcastRoomUpdate(req.params.code);

  const gameModule = AVAILABLE_GAMES[room.gameType];
  if (gameModule && gameModule.initGame) {
    gameModule.initGame(req.params.code);
  }

  res.json({ success: true, sessionId: sid });
});

router.delete('/rooms/:code', (req, res) => {
  const { playerId, isHost } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.disconnectTimers && room.disconnectTimers[playerId]) {
    clearTimeout(room.disconnectTimers[playerId]);
    delete room.disconnectTimers[playerId];
  }

  if (isHost && room.hostId === playerId) {
    broadcastToRoom(req.params.code, { type: 'ROOM_DELETED', reason: 'Host deleted room' });
    rooms.delete(req.params.code);
  } else {
    delete room.players[playerId];
    delete room.audiences[playerId];
    delete room.requests[playerId];
    if (room.disconnectedPlayers) delete room.disconnectedPlayers[playerId];
    updateRoomActivity(req.params.code);
    broadcastRoomUpdate(req.params.code);
  }
  res.json({ success: true });
});

router.post('/rooms/:code/bot', (req, res) => {
  const { hostId, slot, action } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  if (action === 'add') room.players[`BOT_${slot}`] = { name: 'Bot', slot: Number(slot), isBot: true };
  else if (action === 'remove') delete room.players[`BOT_${slot}`];

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

router.post('/rooms/:code/swap', (req, res) => {
  const { hostId, playerId1, playerId2 } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const p1 = room.players[playerId1];
  if (!p1) return res.status(400).json({ error: 'Player 1 not found' });

  if (playerId2.startsWith('empty_')) {
    const targetSlot = parseInt(playerId2.split('_')[1], 10);
    p1.slot = targetSlot;
  } else {
    const p2 = room.players[playerId2];
    if (!p2) return res.status(400).json({ error: 'Player 2 not found' });
    
    const tmp = p1.slot; 
    p1.slot = p2.slot; 
    p2.slot = tmp;
  }

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

router.post('/rooms/:code/promote', (req, res) => {
  const { hostId, audienceId, audienceName, slot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const targetSlot = Number(slot);
  const occupiedByRealPlayer = Object.entries(room.players).some(
    ([pid, p]) => p.slot === targetSlot && !p.isBot
  );
  if (occupiedByRealPlayer) return res.status(400).json({ error: 'Slot is occupied by real player' });
  if (!room.audiences[audienceId]) return res.status(404).json({ error: 'Audience not found' });

  Object.keys(room.players).forEach(pid => {
    if (room.players[pid].slot === targetSlot && room.players[pid].isBot) {
      delete room.players[pid];
    }
  });
  
  delete room.audiences[audienceId];
  room.players[audienceId] = { name: audienceName, slot: targetSlot, isBot: false };

  const sid = playerConnections.get(audienceId);
  if (sid) {
    const conn = connections.get(sid);
    if (conn) conn.isAudience = false;
  }

  updateRoomActivity(req.params.code);
  broadcastRoomUpdate(req.params.code);
  gameEvent(req.params.code, 'CHAT', { sender: 'SERVER', senderName: 'SERVER', message: `${audienceName} replaced Bot in Slot ${targetSlot + 1}` });

  const gameModule = AVAILABLE_GAMES[room.gameType];
  if (gameModule && gameModule.syncPromotedAudience) {
      gameModule.syncPromotedAudience(req.params.code, audienceId, targetSlot);
  }

  res.json({ success: true });
});

router.post('/rooms/:code/replace_bot', (req, res) => {
  const { hostId, slot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  Object.keys(room.players).forEach(pid => {
    if (room.players[pid].slot === Number(slot) && pid.startsWith('BOT_')) delete room.players[pid];
  });
  room.players[`BOT_${slot}`] = { name: 'Bot', slot: Number(slot), isBot: true };

  updateRoomActivity(req.params.code);
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ============================================================
// WEBSOCKET HANDLER
// ============================================================
function handleConnection(ws) {
  const socketId = crypto.randomUUID();
  connections.set(socketId, { ws, playerId: null, roomCode: null, isAudience: false, isAway: false, lastPing: Date.now() });
  ws.send(JSON.stringify({ type: 'CONNECTED', socketId }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(socketId, msg);
    } catch (_) {}
  });

  ws.on('close', () => handleDisconnect(socketId));
  ws.on('error', (err) => console.error(`[WS] ${socketId}:`, err.message));
}

function handleWsMessage(socketId, msg) {
  const conn = connections.get(socketId);
  if (!conn) return;
  conn.lastPing = Date.now();

  switch (msg.type) {
    case 'REGISTER': {
      const { playerId, roomCode, isAudience } = msg;
      if (!playerId || !roomCode) break;

      const old = playerConnections.get(playerId);
      if (old && old !== socketId) {
        const oldConn = connections.get(old);
        if (oldConn) oldConn.roomCode = null;
      }

      conn.playerId = playerId;
      conn.roomCode = roomCode;
      conn.isAudience = isAudience || false;
      conn.isAway = false;
      playerConnections.set(playerId, socketId);

      const room = rooms.get(roomCode);
      if (room) {
        // প্লেয়ার ফিরে এলে তার ডিসকানেক্ট টাইমার বাতিল করা হবে
        if (room.disconnectTimers && room.disconnectTimers[playerId]) {
          clearTimeout(room.disconnectTimers[playerId]);
          delete room.disconnectTimers[playerId];
        }
        // যদি গেম চলাকালীন ডিসকানেক্ট হয়ে বট বসে গিয়ে থাকে, তবে অটো-রিভাইভ করে তার সিট ফিরিয়ে দেওয়া হবে
        tryReviveDisconnectedPlayer(roomCode, room, playerId);
      }
      
      updateRoomActivity(roomCode);
      broadcastRoomUpdate(roomCode);

      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'REGISTERED', playerId, roomCode }));
      }
      return; 
    }
    case 'PING':
      conn.lastPing = Date.now();
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
      return;
    case 'ACTION_AWAY': {
      conn.isAway = true;
      const room = rooms.get(conn.roomCode);
      if (room) {
        const senderIdx = getSlotIndex(room, conn.playerId);
        if (senderIdx !== -1) {
          gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', { slot: senderIdx, isAway: true, playerName: room.players[conn.playerId]?.name });
        }
        updateRoomActivity(conn.roomCode);
        broadcastRoomUpdate(conn.roomCode);
      }
      return;
    }
    case 'ACTION_RETURN': {
      conn.isAway = false;
      const room = rooms.get(conn.roomCode);
      if (room) {
        if (room.disconnectTimers && room.disconnectTimers[conn.playerId]) {
          clearTimeout(room.disconnectTimers[conn.playerId]);
          delete room.disconnectTimers[conn.playerId];
        }
        tryReviveDisconnectedPlayer(conn.roomCode, room, conn.playerId);
        const senderIdx = getSlotIndex(room, conn.playerId);
        if (senderIdx !== -1) {
          gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', { slot: senderIdx, isAway: false, playerName: room.players[conn.playerId]?.name });
        }
        updateRoomActivity(conn.roomCode);
        broadcastRoomUpdate(conn.roomCode);
      }
      return;
    }
    case 'ACTION_CHAT': {
      if (conn.roomCode && msg.message) {
        const room = rooms.get(conn.roomCode);
        if (!room) return;

        const isAudienceMember = Boolean(room.audiences && room.audiences[conn.playerId]) || conn.isAudience;
        const senderName =
          room.players[conn.playerId]?.name ||
          room.audiences[conn.playerId]?.name ||
          room.requests[conn.playerId]?.name ||
          msg.senderName ||
          'Player';

        // অডিয়েন্স হলে প্রতি ৫ মিনিটে ১টি মেসেজ পাঠানোর সীমা চেক করা হবে
        if (isAudienceMember) {
          room.audienceChatTimestamps = room.audienceChatTimestamps || {};
          const lastSent = room.audienceChatTimestamps[conn.playerId] || 0;
          const now = Date.now();
          if (now - lastSent < AUDIENCE_CHAT_COOLDOWN_MS) {
            const remainingSec = Math.ceil((AUDIENCE_CHAT_COOLDOWN_MS - (now - lastSent)) / 1000);
            sendToSocket(socketId, {
              type: 'CHAT_COOLDOWN',
              remainingSeconds: remainingSec,
              message: `Audience can send 1 message every 5 minutes. Please wait ${remainingSec}s.`
            });
            return;
          }
          room.audienceChatTimestamps[conn.playerId] = now;
        }

        gameEvent(conn.roomCode, 'CHAT', {
          sender: senderName,
          senderId: conn.playerId,
          senderName: senderName,
          isAudience: isAudienceMember,
          message: msg.message
        });
      }
      return;
    }
    // ── ওয়েবসকেটের মাধ্যমেও হোস্ট কর্তৃক প্লেয়ার রিমুভ/আন-অ্যাসাইন ও অডিয়েন্স কন্ট্রোল ──
    case 'REMOVE_PLAYER':
    case 'UNASSIGN_PLAYER': {
      const room = rooms.get(conn.roomCode);
      if (!room || room.hostId !== conn.playerId) return;
      const targetId = msg.targetPlayerId;
      if (!targetId || targetId === room.hostId || !room.players[targetId]) return;

      const pData = room.players[targetId];
      delete room.players[targetId];

      if (msg.type === 'UNASSIGN_PLAYER' && !pData.isBot) {
        room.requests[targetId] = { name: pData.name };
        sendToPlayer(targetId, { type: 'UNASSIGNED_TO_REQUESTS' });
      } else if (!pData.isBot) {
        sendToPlayer(targetId, { type: 'KICKED_BY_HOST' });
      }
      updateRoomActivity(conn.roomCode);
      broadcastRoomUpdate(conn.roomCode);
      return;
    }
    case 'KICK_AUDIENCE': {
      const room = rooms.get(conn.roomCode);
      if (!room || room.hostId !== conn.playerId) return;
      const aid = msg.audienceId;
      if (aid && room.audiences[aid]) {
        delete room.audiences[aid];
        sendToPlayer(aid, { type: 'KICKED_BY_HOST', reason: 'Removed from audience by host' });
        broadcastRoomUpdate(conn.roomCode);
      }
      return;
    }
    case 'TOGGLE_AUDIENCE_ALLOW': {
      const room = rooms.get(conn.roomCode);
      if (!room || room.hostId !== conn.playerId) return;
      room.allowAudience = Boolean(msg.allowAudience);
      if (!room.allowAudience && room.audiences) {
        Object.keys(room.audiences).forEach((aid) => {
          sendToPlayer(aid, { type: 'AUDIENCE_DISABLED', reason: 'Host disabled audience viewing' });
        });
        room.audiences = {};
      }
      broadcastRoomUpdate(conn.roomCode);
      return;
    }
  }

  const room = rooms.get(conn.roomCode);
  if (room && AVAILABLE_GAMES[room.gameType]) {
    AVAILABLE_GAMES[room.gameType].handleGameAction(conn.roomCode, conn.playerId, msg);
    updateRoomActivity(conn.roomCode);
  }
}

function handleDisconnect(socketId) {
  const conn = connections.get(socketId);
  if (!conn) return;

  const { playerId, roomCode, isAudience } = conn;

  if (playerId && playerConnections.get(playerId) === socketId) {
    playerConnections.delete(playerId);
  }

  if (playerId && roomCode) {
    const room = rooms.get(roomCode);
    if (room) {
      room.disconnectTimers = room.disconnectTimers || {};

      if (isAudience) {
        // অডিয়েন্স অন্য অ্যাপে গেলে বা নেট ফ্ল্যাকচুয়েট করলে অন্তত ৬০ সেকেন্ড সময় পাবে ফিরে আসার
        room.disconnectTimers[playerId] = setTimeout(() => {
          if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
            const rCheck = rooms.get(roomCode);
            if (rCheck && rCheck.audiences[playerId]) {
              delete rCheck.audiences[playerId];
              broadcastRoomUpdate(roomCode);
            }
          }
        }, 60 * 1000);
      } else {
        // ── রিয়েল প্লেয়ার বা হোস্ট ডিসকানেক্ট হলে:
        // লবিতে (WAITING) থাকলে সাথে সাথে হোস্ট পরিবর্তন বা ১০ সেকেন্ডে কিক করা হবে না!
        // ৫ মিনিট (INACTIVE_ROOM_TIMEOUT_MS) সময় দেওয়া হবে যাতে লিংক শেয়ার করে বা অন্য অ্যাপ থেকে ফিরে আসতে পারে।
        if (room.status === 'WAITING') {
          broadcastRoomUpdate(roomCode);

          room.disconnectTimers[playerId] = setTimeout(() => {
            if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
              const rCheck = rooms.get(roomCode);
              if (!rCheck) return;

              if (rCheck.hostId === playerId) {
                // ৫ মিনিটেও হোস্ট ফিরে না এলে অন্য কোনো অনলাইন হিউম্যান প্লেয়ার থাকলে তাকে হোস্ট বানানো হবে
                const nextHostId = Object.keys(rCheck.players).find(
                  pid => pid !== playerId && !rCheck.players[pid].isBot && playerConnections.has(pid)
                );
                if (nextHostId) {
                  delete rCheck.players[playerId];
                  rCheck.hostId = nextHostId;
                  rCheck.hostName = rCheck.players[nextHostId].name;
                  broadcastRoomUpdate(roomCode);
                  gameEvent(roomCode, 'HOST_CHANGED', { newHostId: nextHostId, newHostName: rCheck.hostName });
                  gameEvent(roomCode, 'CHAT', { sender: 'SERVER', senderName: 'SERVER', message: `${rCheck.hostName} is now the Host.` });
                } else {
                  broadcastToRoom(roomCode, { type: 'ROOM_DELETED', reason: 'Host inactive for 5 minutes' });
                  rooms.delete(roomCode);
                }
              } else if (rCheck.players[playerId]) {
                delete rCheck.players[playerId];
                updateRoomActivity(roomCode);
                broadcastRoomUpdate(roomCode);
              }
            }
          }, INACTIVE_ROOM_TIMEOUT_MS);
        } else if (room.game && room.status === 'PLAYING') {
          // ── গেম চলাকালীন (PLAYING) ডিসকানেক্ট হলে ──
          const slot = getSlotIndex(room, playerId);
          broadcastRoomUpdate(roomCode);
          gameEvent(roomCode, 'PLAYER_DISCONNECTED', { playerId, slot });

          // হোস্ট যদি গেম চলাকালীন ডিসকানেক্ট হয়, তবে সাথে সাথে হোস্ট না বদলে অন্তত ২ মিনিট অপেক্ষা করবে
          if (room.hostId === playerId) {
            room.disconnectTimers[`host_${playerId}`] = setTimeout(() => {
              if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
                const rHost = rooms.get(roomCode);
                if (rHost && rHost.hostId === playerId) {
                  const oldHostSlot = getSlotIndex(rHost, playerId);
                  let newHostId = null;
                  if (oldHostSlot !== -1) {
                    const partnerSlot = (oldHostSlot + 2) % 4;
                    newHostId = Object.keys(rHost.players).find(
                      pid => rHost.players[pid].slot === partnerSlot && !rHost.players[pid].isBot && playerConnections.has(pid)
                    );
                  }
                  if (!newHostId) {
                    newHostId = Object.keys(rHost.players).find(
                      pid => pid !== playerId && !rHost.players[pid].isBot && playerConnections.has(pid)
                    );
                  }
                  if (newHostId) {
                    rHost.hostId = newHostId;
                    rHost.hostName = rHost.players[newHostId].name;
                    broadcastRoomUpdate(roomCode);
                    gameEvent(roomCode, 'HOST_CHANGED', { newHostId, newHostName: rHost.hostName });
                    gameEvent(roomCode, 'CHAT', { sender: 'SERVER', senderName: 'SERVER', message: `${rHost.hostName} is now the Host.` });
                  }
                }
              }
            }, 2 * 60 * 1000);
          }

          room.disconnectTimers[playerId] = setTimeout(() => {
            if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
              const r2 = rooms.get(roomCode);
              if (r2 && r2.players[playerId]) {
                const s = r2.players[playerId].slot;
                const pName = r2.players[playerId].name;

                r2.disconnectedPlayers = r2.disconnectedPlayers || {};
                r2.disconnectedPlayers[playerId] = { slot: s, name: pName };

                delete r2.players[playerId];
                r2.players[`BOT_${s}`] = { name: 'Bot', slot: s, isBot: true };
                updateRoomActivity(roomCode);
                broadcastRoomUpdate(roomCode);
                gameEvent(roomCode, 'CHAT', { sender: 'SERVER', senderName: 'SERVER', message: `${pName} disconnected. Bot took over Slot ${s + 1}.` });

                const gameModule = AVAILABLE_GAMES[room.gameType];
                if (gameModule && gameModule.handlePlayerDisconnectDuringGame) {
                  gameModule.handlePlayerDisconnectDuringGame(roomCode, s);
                }
              }
            }
          }, 15 * 1000);
        }
      }

      updateRoomActivity(roomCode);
    }
  }
  connections.delete(socketId);
}

module.exports.router = router;
module.exports.handleConnection = handleConnection;
