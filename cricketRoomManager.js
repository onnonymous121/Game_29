/**
 * Dedicated Cricket Room Manager (cricketRoomManager.js)
 * =====================================================
 * Supports:
 * - Individual Mode (1v1 - 2 Slots: 0 vs 1)
 * - Team Mode (Up to 11v11 - 22 Slots: Team A [0-10] vs Team B [11-21])
 * - Custom Team Names, Dual Captains, Batting/Fielding Order Management
 * - Central Economy (Entry Fee & Prize Pool) integrated with User model
 */

'use strict';

const express = require('express');
const { WebSocket } = require('ws');
const crypto = require('crypto');
const User = require('./models/User');

const router = express.Router();

// ============================================================
// IN-MEMORY STATE (Isolated from Game 29 & Ludo)
// ============================================================
const cricketRooms = new Map();
const connections = new Map();
const playerConnections = new Map();

module.exports.cricketRooms = cricketRooms;
module.exports.connections = connections;
module.exports.playerConnections = playerConnections;

// ============================================================
// CRICKET ENGINE MODULE
// ============================================================
let cricketEngine = null;
try {
  cricketEngine = require('./games/cricket');
} catch (_) {
  console.log('ℹ️ [Cricket] ./games/cricket.js will be loaded when created.');
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getMaxSlots(playMode) {
  return playMode === 'individual' ? 2 : 22;
}

function findEmptySlotForTeam(players, playMode, preferredTeam = null) {
  const occupied = Object.values(players).map(p => p.slot);
  if (playMode === 'individual') {
    for (let i = 0; i < 2; i++) {
      if (!occupied.includes(i)) return i;
    }
    return -1;
  }

  // Team Mode: Team A (0-10), Team B (11-21)
  if (preferredTeam === 'B') {
    for (let i = 11; i < 22; i++) if (!occupied.includes(i)) return i;
    for (let i = 0; i < 11; i++) if (!occupied.includes(i)) return i;
  } else if (preferredTeam === 'A') {
    for (let i = 0; i < 11; i++) if (!occupied.includes(i)) return i;
    for (let i = 11; i < 22; i++) if (!occupied.includes(i)) return i;
  } else {
    // Auto-balance human players between Team A and Team B
    const teamACount = Object.values(players).filter(p => p.slot < 11).length;
    const teamBCount = Object.values(players).filter(p => p.slot >= 11).length;
    if (teamBCount < teamACount) {
      for (let i = 11; i < 22; i++) if (!occupied.includes(i)) return i;
    }
    for (let i = 0; i < 22; i++) if (!occupied.includes(i)) return i;
  }
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

function assignTeamBCaptainIfNeeded(room) {
  if (room.playMode === 'individual') {
    const oppEntry = Object.entries(room.players).find(([pid, p]) => p.slot === 1 && !p.isBot);
    room.captainBId = oppEntry ? oppEntry[0] : null;
    room.captainBName = oppEntry ? oppEntry[1].name : 'Bot Captain';
    return;
  }

  // Check if current Captain B is still in Team B (slots 11-21)
  if (room.captainBId && room.players[room.captainBId] && room.players[room.captainBId].slot >= 11 && !room.players[room.captainBId].isBot) {
    room.captainBName = room.players[room.captainBId].name;
    return;
  }

  // Find first human player in Team B (slots 11-21)
  const teamBHuman = Object.entries(room.players).find(([pid, p]) => p.slot >= 11 && !p.isBot);
  if (teamBHuman) {
    room.captainBId = teamBHuman[0];
    room.captainBName = teamBHuman[1].name;
  } else {
    room.captainBId = null;
    room.captainBName = 'Waiting...';
  }
}

function broadcastRoomUpdate(roomCode) {
  const room = cricketRooms.get(roomCode);
  if (!room) return;
  assignTeamBCaptainIfNeeded(room);

  broadcastToRoom(roomCode, {
    type: 'ROOM_UPDATE',
    roomCode,
    room: {
      hostId: room.hostId,
      hostName: room.hostName,
      captainAId: room.hostId,
      captainAName: room.hostName,
      captainBId: room.captainBId,
      captainBName: room.captainBName,
      teamAName: room.teamAName,
      teamBName: room.teamBName,
      overs: room.overs,
      status: room.status,
      type: room.type,
      gameType: 'cricket',
      playMode: room.playMode,
      allowAudience: room.allowAudience,
      sessionId: room.sessionId,
      players: room.players,
      requests: room.requests,
      audiences: room.audiences,
      battingOrderA: room.battingOrderA,
      battingOrderB: room.battingOrderB,
      prizePool: room.prizePool || 0
    },
  });
}

function gameEvent(roomCode, event, payload, targetPlayerId = null) {
  const msg = { type: 'GAME_EVENT', event, payload: payload || {} };
  if (targetPlayerId) sendToPlayer(targetPlayerId, msg);
  else broadcastToRoom(roomCode, msg);
}

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

function updateRoomActivity(roomCode) {
  const room = cricketRooms.get(roomCode);
  if (!room) return;
  if (hasActiveHumanPlayer(room)) {
    room.emptySince = null;
  } else if (!room.emptySince) {
    room.emptySince = Date.now();
  }
}

const INACTIVE_ROOM_TIMEOUT_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  cricketRooms.forEach((room, roomCode) => {
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
        cricketRooms.delete(roomCode);
      }
    }
  });
}, 15 * 1000);

module.exports.broadcastToRoom = broadcastToRoom;
module.exports.broadcastRoomUpdate = broadcastRoomUpdate;
module.exports.gameEvent = gameEvent;

// ============================================================
// ECONOMY & REWARD RESOLUTION
// ============================================================
function getFeeBasedOnLevel(level) {
  if (level <= 20) return 150;
  else if (level <= 40) return 200;
  else if (level <= 60) return 250;
  else if (level <= 80) return 300;
  else if (level <= 100) return 350;
  else return 400;
}

function calculateDynamicLevel(xp) {
  return Math.min(120, Math.max(1, Math.floor(xp / 500) + 1));
}

async function resolveCricketGame(roomCode, winningTeam) {
  // winningTeam: 'A' (slots 0-10 or slot 0) or 'B' (slots 11-21 or slot 1)
  const room = cricketRooms.get(roomCode);
  if (!room) return;

  const realPlayers = Object.keys(room.players).filter(pid => !room.players[pid].isBot);
  const winners = [];
  const losers = [];

  for (let pid of realPlayers) {
    const slot = room.players[pid].slot;
    const isTeamA = room.playMode === 'individual' ? (slot === 0) : (slot < 11);
    if ((winningTeam === 'A' && isTeamA) || (winningTeam === 'B' && !isTeamA)) {
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

module.exports.resolveCricketGame = resolveCricketGame;

// ============================================================
// HTTP REST API (Cricket Lobby & Team Controls)
// ============================================================

router.get('/rooms', (req, res) => {
  const list = [];
  const { playMode } = req.query; // optional filter: 'team' or 'individual'

  cricketRooms.forEach((room, code) => {
    if (room.type !== 'public') return;
    if (playMode && playMode !== 'all' && room.playMode !== playMode) return;

    if (!hasActiveHumanPlayer(room) && room.emptySince && (Date.now() - room.emptySince >= INACTIVE_ROOM_TIMEOUT_MS)) {
      cricketRooms.delete(code);
      return;
    }

    const maxSlots = getMaxSlots(room.playMode);
    const playerCount = Object.keys(room.players).length;
    const canJoin = (room.status === 'WAITING' && (playerCount < maxSlots || room.allowAudience))
                 || (room.status === 'PLAYING' && room.allowAudience);

    if (canJoin) {
      list.push({
        code,
        hostName: room.hostName,
        teamAName: room.teamAName,
        teamBName: room.teamBName,
        overs: room.overs,
        playerCount,
        maxPlayers: maxSlots,
        allowsAudience: room.allowAudience,
        status: room.status,
        gameType: 'cricket',
        playMode: room.playMode
      });
    }
  });
  res.json(list);
});

router.get('/rooms/:code', (req, res) => {
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Cricket Room not found' });
  res.json({
    code: req.params.code,
    hostId: room.hostId,
    hostName: room.hostName,
    captainAId: room.hostId,
    captainBId: room.captainBId,
    teamAName: room.teamAName,
    teamBName: room.teamBName,
    overs: room.overs,
    status: room.status,
    type: room.type,
    allowAudience: room.allowAudience,
    gameType: 'cricket',
    playMode: room.playMode,
    sessionId: room.sessionId,
    playerCount: Object.keys(room.players).length,
    maxPlayers: getMaxSlots(room.playMode),
    players: room.players,
    requests: room.requests,
    audiences: room.audiences,
  });
});

// Create Cricket Room (Supports Team Name & Mode)
router.post('/rooms/create', (req, res) => {
  const { playerId, playerName, type, allowAudience, playMode, teamName, overs } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  cricketRooms.forEach((r, code) => { if (r.hostId === playerId) cricketRooms.delete(code); });

  const roomCode = generateRoomCode();
  const finalPlayMode = playMode === 'individual' ? 'individual' : 'team';
  const defaultTeamA = finalPlayMode === 'team' ? (teamName && teamName.trim() ? teamName.trim() : `${playerName}'s XI`) : playerName;
  const defaultTeamB = finalPlayMode === 'team' ? 'Challengers XI' : 'Opponent';

  cricketRooms.set(roomCode, {
    hostId: playerId,
    hostName: playerName,
    captainBId: null,
    captainBName: 'Waiting...',
    teamAName: defaultTeamA,
    teamBName: defaultTeamB,
    overs: Number(overs) || 5,
    status: 'WAITING',
    type: type === 'private' ? 'private' : 'public',
    gameType: 'cricket',
    playMode: finalPlayMode,
    allowAudience: allowAudience !== false,
    sessionId: null,
    createdAt: Date.now(),
    emptySince: null,
    players: { [playerId]: { name: playerName, slot: 0, isBot: false } },
    requests: {},
    audiences: {},
    battingOrderA: [0],
    battingOrderB: [],
    game: null,
    disconnectedPlayers: {},
    prizePool: 0,
  });

  res.json({
    success: true,
    roomCode,
    gameType: 'cricket',
    playMode: finalPlayMode,
    teamAName: defaultTeamA,
    teamBName: defaultTeamB
  });
});

// Join Cricket Room
router.post('/rooms/:code/join', (req, res) => {
  const { playerId, playerName, asAudience, preferredTeam, teamName } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Rejoin check if previously disconnected during match
  if (room.disconnectedPlayers && room.disconnectedPlayers[playerId]) {
    const oldData = room.disconnectedPlayers[playerId];
    if (room.players[`BOT_${oldData.slot}`]) {
      delete room.players[`BOT_${oldData.slot}`];
      room.players[playerId] = { name: playerName, slot: oldData.slot, isBot: false };
      delete room.disconnectedPlayers[playerId];
      room.emptySince = null;
      broadcastRoomUpdate(req.params.code);
      gameEvent(req.params.code, 'CHAT', { sender: 'SERVER', message: `${playerName} rejoined the match.` });
      gameEvent(req.params.code, 'PLAYER_REJOINED', { playerId, slot: oldData.slot, playerName });
      return res.json({ role: 'player', reason: 'rejoined', gameType: 'cricket', playMode: room.playMode });
    }
  }

  if (asAudience) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Audience not allowed' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', gameType: 'cricket', playMode: room.playMode });
  }

  if (room.status === 'PLAYING') {
    if (!room.allowAudience) return res.status(403).json({ error: 'Match in progress' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'game_started', gameType: 'cricket', playMode: room.playMode });
  }

  const maxSlots = getMaxSlots(room.playMode);
  if (Object.keys(room.players).length >= maxSlots) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Room full' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'room_full', gameType: 'cricket', playMode: room.playMode });
  }

  room.requests[playerId] = {
    name: playerName,
    preferredTeam: preferredTeam || null,
    requestedTeamName: teamName || null
  };
  broadcastRoomUpdate(req.params.code);
  res.json({ role: 'requested', gameType: 'cricket', playMode: room.playMode });
});

// Admit Player (Host or Captain B can admit)
router.post('/rooms/:code/admit', (req, res) => {
  const { hostId, playerId, assignTeam } = req.body;
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId && room.captainBId !== hostId) {
    return res.status(403).json({ error: 'Only Host or Team Captain can admit players' });
  }

  const reqData = room.requests[playerId];
  if (!reqData) return res.status(404).json({ error: 'Request not found' });

  const slot = findEmptySlotForTeam(room.players, room.playMode, assignTeam || reqData.preferredTeam);
  if (slot === -1) return res.status(400).json({ error: 'No empty slot available' });

  delete room.requests[playerId];
  room.players[playerId] = { name: reqData.name, slot, isBot: false };

  // If this player is the first human in Team B and provided a custom team name, set Team B's name
  if (room.playMode === 'team' && slot >= 11 && !room.captainBId && reqData.requestedTeamName) {
    room.teamBName = reqData.requestedTeamName.trim();
  }

  assignTeamBCaptainIfNeeded(room);
  updateRoomActivity(req.params.code);
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true, slot });
});

router.post('/rooms/:code/reject', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId && room.captainBId !== hostId) return res.status(403).json({ error: 'Not authorized' });

  delete room.requests[playerId];
  const sid = playerConnections.get(playerId);
  if (sid) sendToSocket(sid, { type: 'REJECTED' });
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// Update Team Name or Overs (Host for Team A & Overs, Captain B for Team B)
router.post('/rooms/:code/team_settings', (req, res) => {
  const { playerId, teamAName, teamBName, overs } = req.body;
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (playerId === room.hostId) {
    if (teamAName && teamAName.trim()) room.teamAName = teamAName.trim();
    if (teamBName && teamBName.trim() && !room.captainBId) room.teamBName = teamBName.trim();
    if (overs) room.overs = Number(overs);
  } else if (playerId === room.captainBId) {
    if (teamBName && teamBName.trim()) room.teamBName = teamBName.trim();
  } else {
    return res.status(403).json({ error: 'Only Captains can update team settings' });
  }

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// Add or Remove Bot in specific slot (Host or Captain B for their own team)
router.post('/rooms/:code/bot', (req, res) => {
  const { hostId, slot, action } = req.body;
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const targetSlot = Number(slot);
  const isCaptainBAllowed = room.captainBId === hostId && targetSlot >= 11;
  if (room.hostId !== hostId && !isCaptainBAllowed) {
    return res.status(403).json({ error: 'Not authorized for this slot' });
  }

  if (action === 'add') {
    room.players[`BOT_${targetSlot}`] = { name: `Bot ${targetSlot + 1}`, slot: targetSlot, isBot: true };
  } else if (action === 'remove') {
    delete room.players[`BOT_${targetSlot}`];
  }

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// Swap Slots / Switch Teams / Reorder Lineup
router.post('/rooms/:code/swap', (req, res) => {
  const { hostId, playerId1, playerId2 } = req.body;
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId && room.captainBId !== hostId) {
    return res.status(403).json({ error: 'Only Captains can reorder slots' });
  }

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

  assignTeamBCaptainIfNeeded(room);
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// Start Match (Requires at least 1 player/bot in Team A and 1 in Team B)
router.post('/rooms/:code/start', async (req, res) => {
  const { hostId, sessionId } = req.body;
  const room = cricketRooms.get(req.params.code);

  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Only the Host can start the match' });

  const slots = Object.values(room.players).map(p => p.slot);
  const hasTeamA = room.playMode === 'individual' ? slots.includes(0) : slots.some(s => s < 11);
  const hasTeamB = room.playMode === 'individual' ? slots.includes(1) : slots.some(s => s >= 11);

  if (!hasTeamA || !hasTeamB) {
    return res.status(400).json({ error: 'Both sides must have at least 1 player or bot to start the match!' });
  }

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

  if (!cricketEngine) {
    try { cricketEngine = require('./games/cricket'); } catch (_) {}
  }
  if (cricketEngine && cricketEngine.initGame) {
    cricketEngine.initGame(req.params.code);
  } else {
    gameEvent(req.params.code, 'GAME_STARTED', { sessionId: sid });
  }

  res.json({ success: true, sessionId: sid });
});

router.delete('/rooms/:code', (req, res) => {
  const { playerId, isHost } = req.body;
  const room = cricketRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (isHost && room.hostId === playerId) {
    broadcastToRoom(req.params.code, { type: 'ROOM_DELETED', reason: 'Host closed the room' });
    cricketRooms.delete(req.params.code);
  } else {
    delete room.players[playerId];
    delete room.audiences[playerId];
    delete room.requests[playerId];
    assignTeamBCaptainIfNeeded(room);
    updateRoomActivity(req.params.code);
    broadcastRoomUpdate(req.params.code);
  }
  res.json({ success: true });
});

// ============================================================
// WEBSOCKET HANDLER
// ============================================================
function handleConnection(ws) {
  const socketId = crypto.randomUUID();
  connections.set(socketId, { ws, playerId: null, roomCode: null, isAudience: false, isAway: false });
  ws.send(JSON.stringify({ type: 'CONNECTED', socketId }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(socketId, msg);
    } catch (_) {}
  });

  ws.on('close', () => handleDisconnect(socketId));
  ws.on('error', (err) => console.error(`[Cricket WS] ${socketId}:`, err.message));
}

function handleWsMessage(socketId, msg) {
  const conn = connections.get(socketId);
  if (!conn) return;

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

      updateRoomActivity(roomCode);

      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'REGISTERED', playerId, roomCode }));
      }
      return;
    }
    case 'PING':
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
      return;
    case 'ACTION_AWAY': {
      conn.isAway = true;
      const room = cricketRooms.get(conn.roomCode);
      if (room) {
        const senderIdx = getSlotIndex(room, conn.playerId);
        if (senderIdx !== -1) {
          gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', {
            slot: senderIdx,
            isAway: true,
            playerName: room.players[conn.playerId]?.name
          });
        }
        updateRoomActivity(conn.roomCode);
      }
      return;
    }
    case 'ACTION_RETURN': {
      conn.isAway = false;
      const room = cricketRooms.get(conn.roomCode);
      if (room) {
        const senderIdx = getSlotIndex(room, conn.playerId);
        if (senderIdx !== -1) {
          gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', {
            slot: senderIdx,
            isAway: false,
            playerName: room.players[conn.playerId]?.name
          });
        }
        updateRoomActivity(conn.roomCode);
      }
      return;
    }
    case 'ACTION_CHAT': {
      if (conn.roomCode && msg.message) {
        gameEvent(conn.roomCode, 'CHAT', { sender: conn.playerId, message: msg.message });
      }
      return;
    }
  }

  const room = cricketRooms.get(conn.roomCode);
  if (room) {
    if (!cricketEngine) {
      try { cricketEngine = require('./games/cricket'); } catch (_) {}
    }
    if (cricketEngine && cricketEngine.handleGameAction) {
      cricketEngine.handleGameAction(conn.roomCode, conn.playerId, msg);
    }
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
    const room = cricketRooms.get(roomCode);
    if (room) {
      if (isAudience) {
        delete room.audiences[playerId];
        broadcastRoomUpdate(roomCode);
      } else if (room.hostId === playerId) {
        // Promote another active human from Team A first, otherwise any active human
        let newHostId = Object.keys(room.players).find(
          pid => pid !== playerId && room.players[pid].slot < 11 && !room.players[pid].isBot && playerConnections.has(pid)
        );
        if (!newHostId) {
          newHostId = Object.keys(room.players).find(
            pid => pid !== playerId && !room.players[pid].isBot && playerConnections.has(pid)
          );
        }

        if (newHostId) {
          room.hostId = newHostId;
          room.hostName = room.players[newHostId].name;
          broadcastRoomUpdate(roomCode);
          gameEvent(roomCode, 'HOST_CHANGED', { newHostId, newHostName: room.hostName });
        } else if (room.status === 'WAITING') {
          setTimeout(() => {
            if (!playerConnections.has(playerId) && cricketRooms.has(roomCode)) {
              const rCheck = cricketRooms.get(roomCode);
              if (!hasActiveHumanPlayer(rCheck)) {
                broadcastToRoom(roomCode, { type: 'ROOM_DELETED', reason: 'Host disconnected and no active players left' });
                cricketRooms.delete(roomCode);
              }
            }
          }, 15000);
        }
      }

      if (!isAudience) {
        if (room.game && room.status === 'PLAYING') {
          const slot = getSlotIndex(room, playerId);
          gameEvent(roomCode, 'PLAYER_DISCONNECTED', { playerId, slot });

          setTimeout(() => {
            if (!playerConnections.has(playerId) && cricketRooms.has(roomCode)) {
              const r2 = cricketRooms.get(roomCode);
              if (r2 && r2.players[playerId]) {
                const s = r2.players[playerId].slot;
                const pName = r2.players[playerId].name;

                r2.disconnectedPlayers = r2.disconnectedPlayers || {};
                r2.disconnectedPlayers[playerId] = { slot: s, name: pName };

                delete r2.players[playerId];
                r2.players[`BOT_${s}`] = { name: `Bot (${pName})`, slot: s, isBot: true };
                assignTeamBCaptainIfNeeded(r2);
                updateRoomActivity(roomCode);
                broadcastRoomUpdate(roomCode);

                if (cricketEngine && cricketEngine.handlePlayerDisconnectDuringGame) {
                  cricketEngine.handlePlayerDisconnectDuringGame(roomCode, s);
                }
              }
            }
          }, 15000);
        } else if (room.status === 'WAITING' && room.hostId !== playerId) {
          setTimeout(() => {
            if (!playerConnections.has(playerId) && cricketRooms.has(roomCode)) {
              delete room.players[playerId];
              assignTeamBCaptainIfNeeded(room);
              updateRoomActivity(roomCode);
              broadcastRoomUpdate(roomCode);
            }
          }, 10000);
        }
      }
      updateRoomActivity(roomCode);
    }
  }
  connections.delete(socketId);
}

module.exports.router = router;
module.exports.handleConnection = handleConnection;