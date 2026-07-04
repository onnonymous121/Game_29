/**
 * Universal Room Manager
 * =====================================================
 * এটি সমস্ত গেমের (Game 29, Ludo, CallBreak) রুম কন্ট্রোল করবে।
 * গেমের স্পেসিফিক লজিক নিজ নিজ মডিউলে (যেমন: games/game29.js) থাকবে।
 */

'use strict';

const express = require('express');
const { WebSocket } = require('ws');
const crypto = require('crypto');

const router = express.Router();

// ============================================================
// IN-MEMORY STATE
// ============================================================
const rooms = new Map();
const connections = new Map();
const playerConnections = new Map();

// ── এক্সপোর্ট ── (যাতে গেম মডিউলগুলো রুম ডেটা এক্সেস করতে পারে)
module.exports.rooms = rooms;
module.exports.connections = connections;
module.exports.playerConnections = playerConnections;

// ============================================================
// GAME MODULES REGISTRY
// ============================================================
// নতুন গেম আসলে শুধু এখানে রিকোয়ার করে অ্যাড করে দিলেই হবে।
const game29Module = require('./games/game29');

const AVAILABLE_GAMES = {
  '29': game29Module,
  // 'ludo': ludoModule, // ভবিষ্যতে যুক্ত হবে
  // 'callbreak': callBreakModule 
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

function broadcastRoomUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  broadcastToRoom(roomCode, {
    type: 'ROOM_UPDATE',
    roomCode,
    room: {
      hostId: room.hostId, hostName: room.hostName,
      status: room.status, type: room.type, gameType: room.gameType,
      allowAudience: room.allowAudience, sessionId: room.sessionId,
      players: room.players, requests: room.requests, audiences: room.audiences,
    },
  });
}

function gameEvent(roomCode, event, payload, targetPlayerId = null) {
  const msg = { type: 'GAME_EVENT', event, payload: payload || {} };
  if (targetPlayerId) sendToPlayer(targetPlayerId, msg);
  else broadcastToRoom(roomCode, msg);
}

module.exports.broadcastToRoom = broadcastToRoom;
module.exports.broadcastRoomUpdate = broadcastRoomUpdate;
module.exports.gameEvent = gameEvent;

// ============================================================
// HTTP REST API (Room CRUD & Lobby)
// ============================================================

router.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, connections: connections.size, uptime: Math.floor(process.uptime()) });
});

// পাবলিক রুম লিস্ট (ফিল্টার অপশন সহ)
router.get('/rooms', (req, res) => {
  const list = [];
  const { gameType } = req.query; // ফ্রন্টএন্ড থেকে gameType ফিল্টার আসবে

  rooms.forEach((room, code) => {
    if (room.type !== 'public') return;
    if (gameType && room.gameType !== gameType && gameType !== 'all') return; // ফিল্টারিং

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
        gameType: room.gameType 
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
    gameType: room.gameType, sessionId: room.sessionId, 
    playerCount: Object.keys(room.players).length,
    players: room.players, requests: room.requests, audiences: room.audiences,
  });
});

router.post('/rooms/create', (req, res) => {
  const { playerId, playerName, type, allowAudience, gameType } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  // ক্লিনআপ: একই ইউজারের অন্য কোনো রুম থাকলে ডিলিট করে দেওয়া
  rooms.forEach((r, code) => { if (r.hostId === playerId) rooms.delete(code); });

  const roomCode = generateRoomCode();
  const finalGameType = gameType || '29'; // বাই ডিফল্ট 29 

  rooms.set(roomCode, {
    hostId: playerId, hostName: playerName,
    status: 'WAITING',
    type: type === 'private' ? 'private' : 'public',
    gameType: finalGameType, 
    allowAudience: allowAudience !== false,
    sessionId: null, createdAt: Date.now(),
    players: { [playerId]: { name: playerName, slot: 0, isBot: false } },
    requests: {}, audiences: {},
    game: null,
    disconnectedPlayers: {},
  });
  res.json({ success: true, roomCode, gameType: finalGameType });
});

router.post('/rooms/:code/join', (req, res) => {
  const { playerId, playerName, asAudience } = req.body;
  if (!playerId || !playerName) return res.status(400).json({ error: 'playerId and playerName required' });

  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Seat Recovery
  if (room.disconnectedPlayers && room.disconnectedPlayers[playerId]) {
    const oldData = room.disconnectedPlayers[playerId];
    if (room.players[`BOT_${oldData.slot}`]) {
      delete room.players[`BOT_${oldData.slot}`];
      room.players[playerId] = { name: playerName, slot: oldData.slot, isBot: false };
      delete room.disconnectedPlayers[playerId];
      broadcastRoomUpdate(req.params.code);
      gameEvent(req.params.code, 'CHAT', { sender: 'SERVER', message: `${playerName} rejoined the game and took back their seat.` });
      gameEvent(req.params.code, 'PLAYER_REJOINED', { playerId, slot: oldData.slot, playerName });
      return res.json({ role: 'player', reason: 'rejoined', gameType: room.gameType });
    }
  }

  if (asAudience) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Audience not allowed' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', gameType: room.gameType });
  }

  if (room.status === 'PLAYING') {
    if (!room.allowAudience) return res.status(403).json({ error: 'Game in progress' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'game_started', gameType: room.gameType });
  }

  if (Object.keys(room.players).length >= 4) {
    if (!room.allowAudience) return res.status(403).json({ error: 'Room full' });
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ role: 'audience', reason: 'room_full', gameType: room.gameType });
  }

  room.requests[playerId] = { name: playerName };
  broadcastRoomUpdate(req.params.code);
  res.json({ role: 'requested', gameType: room.gameType });
});

router.post('/rooms/:code/admit', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const req2 = room.requests[playerId];
  if (!req2) return res.status(404).json({ error: 'Request not found' });

  const slot = findFirstEmptySlot(room.players);
  if (slot === -1) return res.status(400).json({ error: 'Room full' });

  delete room.requests[playerId];
  room.players[playerId] = { name: req2.name, slot, isBot: false };
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
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

router.post('/rooms/:code/start', (req, res) => {
  const { hostId, sessionId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  // ফিল বটস
  for (let i = 0; i < 4; i++) {
    const occupied = Object.values(room.players).map(p => p.slot);
    if (!occupied.includes(i)) {
      room.players[`BOT_${i}`] = { name: 'Bot', slot: i, isBot: true };
    }
  }

  const sid = sessionId || crypto.randomUUID();
  room.sessionId = sid;
  room.status = 'PLAYING';
  broadcastRoomUpdate(req.params.code);

  // ── নির্দিষ্ট গেমের ইনিশিয়ালাইজার কল করা ──
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

  if (isHost) {
    broadcastToRoom(req.params.code, { type: 'ROOM_DELETED', reason: 'Host deleted room' });
    rooms.delete(req.params.code);
  } else {
    delete room.players[playerId];
    delete room.audiences[playerId];
    delete room.requests[playerId];
    broadcastRoomUpdate(req.params.code);
  }
  res.json({ success: true });
});

// ── লবির অন্যান্য ফাংশন ──
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

  const p1 = room.players[playerId1], p2 = room.players[playerId2];
  if (!p1 || !p2) return res.status(400).json({ error: 'Player not found' });
  const tmp = p1.slot; p1.slot = p2.slot; p2.slot = tmp;

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

  broadcastRoomUpdate(req.params.code);
  gameEvent(req.params.code, 'CHAT', { sender: 'SERVER', message: `${audienceName} replaced Bot in Slot ${targetSlot + 1}` });

  // Sync state for promoted audience will be handled by the game module
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

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ============================================================
// WEBSOCKET HANDLER
// ============================================================
function handleConnection(ws) {
  const socketId = crypto.randomUUID();
  connections.set(socketId, { ws, playerId: null, roomCode: null, isAudience: false });
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

  // ── সাধারণ গ্লোবাল ইভেন্ট ──
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
      playerConnections.set(playerId, socketId);
      
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
      const room = rooms.get(conn.roomCode);
      if (room) {
        const senderIdx = getSlotIndex(room, conn.playerId);
        if (senderIdx !== -1) gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', { slot: senderIdx, isAway: true, playerName: room.players[conn.playerId]?.name });
      }
      return;
    }
    case 'ACTION_RETURN': {
      const room = rooms.get(conn.roomCode);
      if (room) {
        const senderIdx = getSlotIndex(room, conn.playerId);
        if (senderIdx !== -1) gameEvent(conn.roomCode, 'PLAYER_AWAY_STATE', { slot: senderIdx, isAway: false, playerName: room.players[conn.playerId]?.name });
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

  // ── গেম-স্পেসিফিক ইভেন্ট ──
  const room = rooms.get(conn.roomCode);
  if (room && AVAILABLE_GAMES[room.gameType]) {
    // নির্দিষ্ট গেমের মডিউলের কাছে রিকোয়েস্ট পাঠিয়ে দেওয়া হলো
    AVAILABLE_GAMES[room.gameType].handleGameAction(conn.roomCode, conn.playerId, msg);
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
      if (isAudience) {
        delete room.audiences[playerId];
        broadcastRoomUpdate(roomCode);
      } else if (room.hostId === playerId) {
        
        // ── HOST MIGRATION ──
        const oldHostSlot = getSlotIndex(room, playerId);
        let newHostId = null;

        if (oldHostSlot !== -1) {
          const partnerSlot = (oldHostSlot + 2) % 4;
          newHostId = Object.keys(room.players).find(pid => room.players[pid].slot === partnerSlot && !room.players[pid].isBot);
        }
        if (!newHostId) {
          newHostId = Object.keys(room.players).find(pid => pid !== playerId && !room.players[pid].isBot);
        }

        if (newHostId) {
          room.hostId = newHostId;
          room.hostName = room.players[newHostId].name;
          broadcastRoomUpdate(roomCode);
          gameEvent(roomCode, 'HOST_CHANGED', { newHostId: newHostId, newHostName: room.hostName });
          gameEvent(roomCode, 'CHAT', { sender: 'SERVER', message: `${room.hostName} is now the Host.` });
        } else {
          setTimeout(() => {
            if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
              const rCheck = rooms.get(roomCode);
              const hasHumans = Object.keys(rCheck.players).some(pid => !rCheck.players[pid].isBot);
              if (!hasHumans) {
                broadcastToRoom(roomCode, { type: 'ROOM_DELETED', reason: 'Host disconnected and no active players left' });
                rooms.delete(roomCode);
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
            if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
              const r2 = rooms.get(roomCode);
              if (r2 && r2.players[playerId]) {
                const s = r2.players[playerId].slot;
                const pName = r2.players[playerId].name;

                r2.disconnectedPlayers = r2.disconnectedPlayers || {};
                r2.disconnectedPlayers[playerId] = { slot: s, name: pName };

                delete r2.players[playerId];
                r2.players[`BOT_${s}`] = { name: 'Bot', slot: s, isBot: true };
                broadcastRoomUpdate(roomCode);
                gameEvent(roomCode, 'CHAT', { sender: 'SERVER', message: `${pName} disconnected. Bot took over Slot ${s + 1}.` });

                // ── গেম স্পেসিফিক ডিসকানেক্ট লজিক কল করা ──
                const gameModule = AVAILABLE_GAMES[room.gameType];
                if (gameModule && gameModule.handlePlayerDisconnectDuringGame) {
                    gameModule.handlePlayerDisconnectDuringGame(roomCode, s);
                }
              }
            }
          }, 15 * 1000);
        } else if (room.status === 'WAITING' && room.hostId !== playerId) {
            setTimeout(() => {
                if (!playerConnections.has(playerId) && rooms.has(roomCode)) {
                    delete room.players[playerId];
                    broadcastRoomUpdate(roomCode);
                }
            }, 10000);
        }
      }
    }
  }
  connections.delete(socketId);
}

module.exports.router = router;
module.exports.handleConnection = handleConnection;