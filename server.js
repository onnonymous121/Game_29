/**
 * Game 29 — Free Multiplayer Backend
 * ====================================
 * Node.js server combining Express HTTP REST API + WebSocket (ws) server.
 * Replaces Firebase Realtime Database completely.
 *
 * Deploy for FREE on:
 *   - Render.com (render.yaml included)
 *   - Railway.app
 *   - Fly.io
 *
 * Architecture:
 *   - HTTP endpoints handle room management (create/join/start/leave)
 *   - WebSocket handles real-time game message routing
 *   - All game LOGIC stays on the Flutter HOST client (host-driven model)
 *   - This server is a dumb router — it does not understand game rules
 *
 * Message Protocol (same as the original Firebase protocol):
 *   Flutter sends: { type: "GAME_MSG", sender, target, data, sessionId }
 *   Server routes to: target="ALL" (broadcast), target="HOST", target=playerId
 *   Flutter receives: { type: "GAME_MSG", sender, data, sessionId, roomCode }
 */

'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// ============================================================
// IN-MEMORY STATE
// ============================================================

/**
 * rooms: Map<roomCode, RoomState>
 * RoomState: {
 *   hostId:        string,
 *   hostName:      string,
 *   status:        'WAITING' | 'PLAYING',
 *   type:          'public' | 'private',
 *   allowAudience: boolean,
 *   sessionId:     string | null,
 *   createdAt:     number (timestamp),
 *   players:       { [playerId]: { name, slot, isBot } },
 *   requests:      { [playerId]: { name } },
 *   audiences:     { [playerId]: { name } },
 * }
 */
const rooms = new Map();

/**
 * connections: Map<socketId, ConnectionState>
 * ConnectionState: { ws, playerId, roomCode, isAudience }
 */
const connections = new Map();

/**
 * playerConnections: Map<playerId, socketId>
 * Fast reverse lookup: which socket belongs to which player
 */
const playerConnections = new Map();


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getOccupiedSlots(players) {
  return Object.values(players).map(p => p.slot);
}

function findFirstEmptySlot(players) {
  const occupied = getOccupiedSlots(players);
  for (let i = 0; i < 4; i++) {
    if (!occupied.includes(i)) return i;
  }
  return -1;
}

function sendToSocket(socketId, payload) {
  const conn = connections.get(socketId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
}

function broadcastToRoom(roomCode, payload, excludePlayerId = null) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  connections.forEach((conn) => {
    if (conn.roomCode === roomCode && conn.playerId !== excludePlayerId) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(raw);
      }
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
      hostId: room.hostId,
      hostName: room.hostName,
      status: room.status,
      type: room.type,
      allowAudience: room.allowAudience,
      sessionId: room.sessionId,
      players: room.players,
      requests: room.requests,
      audiences: room.audiences,
    },
  });
}

function routeGameMessage(roomCode, senderPlayerId, target, data, sessionId) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const payload = JSON.stringify({
    type: 'GAME_MSG',
    sender: senderPlayerId,
    data,
    sessionId: sessionId || '',
    roomCode,
  });

  if (target === 'ALL') {
    // Broadcast to everyone in the room EXCEPT the sender
    broadcastToRoom(roomCode, payload, senderPlayerId);
  } else if (target === 'HOST') {
    const hostSocketId = playerConnections.get(room.hostId);
    sendToSocket(hostSocketId, payload);
  } else {
    // Target is a specific playerId
    const targetSocketId = playerConnections.get(target);
    sendToSocket(targetSocketId, payload);
  }
}


// ============================================================
// HTTP REST API
// ============================================================

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    connections: connections.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ── GET /rooms ───────────────────────────────────────────────
// List all joinable public rooms
app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room, code) => {
    if (room.type !== 'public') return;
    const playerCount = Object.keys(room.players).length;
    const canJoin =
      (room.status === 'WAITING' && (playerCount < 4 || room.allowAudience)) ||
      (room.status === 'PLAYING' && room.allowAudience);
    if (canJoin) {
      list.push({
        code,
        hostName: room.hostName,
        playerCount,
        allowsAudience: room.allowAudience,
        status: room.status,
      });
    }
  });
  res.json(list);
});

// ── GET /rooms/:code ─────────────────────────────────────────
// Get full room information
app.get('/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: req.params.code,
    hostId: room.hostId,
    hostName: room.hostName,
    status: room.status,
    type: room.type,
    allowAudience: room.allowAudience,
    sessionId: room.sessionId,
    playerCount: Object.keys(room.players).length,
    players: room.players,
    requests: room.requests,
    audiences: room.audiences,
  });
});

// ── POST /rooms/create ───────────────────────────────────────
// Create a new room (host calls this)
app.post('/rooms/create', (req, res) => {
  const { playerId, playerName, type, allowAudience } = req.body;
  if (!playerId || !playerName) {
    return res.status(400).json({ error: 'playerId and playerName are required' });
  }

  // Prevent duplicate rooms by the same host
  rooms.forEach((r, code) => {
    if (r.hostId === playerId) rooms.delete(code);
  });

  const roomCode = generateRoomCode();
  rooms.set(roomCode, {
    hostId: playerId,
    hostName: playerName,
    status: 'WAITING',
    type: type === 'private' ? 'private' : 'public',
    allowAudience: allowAudience !== false,
    sessionId: null,
    createdAt: Date.now(),
    players: {
      [playerId]: { name: playerName, slot: 0, isBot: false },
    },
    requests: {},
    audiences: {},
  });

  res.json({ success: true, roomCode });
});

// ── POST /rooms/:code/join ────────────────────────────────────
// Request to join a room (as player or audience)
app.post('/rooms/:code/join', (req, res) => {
  const { playerId, playerName, asAudience } = req.body;
  if (!playerId || !playerName) {
    return res.status(400).json({ error: 'playerId and playerName are required' });
  }

  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (asAudience) {
    if (!room.allowAudience) {
      return res.status(403).json({ error: 'Audience not allowed in this room' });
    }
    room.audiences[playerId] = { name: playerName };
    broadcastRoomUpdate(req.params.code);
    return res.json({ success: true, role: 'audience' });
  }

  // Joining as player
  if (room.status === 'PLAYING') {
    if (room.allowAudience) {
      room.audiences[playerId] = { name: playerName };
      broadcastRoomUpdate(req.params.code);
      return res.json({ success: true, role: 'audience', reason: 'game_started' });
    }
    return res.status(400).json({ error: 'Game already started' });
  }

  const playerCount = Object.keys(room.players).filter(id => !id.startsWith('BOT_')).length;
  if (playerCount >= 4) {
    if (room.allowAudience) {
      room.audiences[playerId] = { name: playerName };
      broadcastRoomUpdate(req.params.code);
      return res.json({ success: true, role: 'audience', reason: 'room_full' });
    }
    return res.status(400).json({ error: 'Room is full' });
  }

  room.requests[playerId] = { name: playerName };
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true, role: 'requested' });
});

// ── POST /rooms/:code/admit ───────────────────────────────────
// Host admits a player from the request queue
app.post('/rooms/:code/admit', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const reqPlayer = room.requests[playerId];
  if (!reqPlayer) return res.status(400).json({ error: 'Player not in request queue' });

  const slot = findFirstEmptySlot(room.players);
  if (slot === -1) return res.status(400).json({ error: 'No empty slots' });

  room.players[playerId] = { name: reqPlayer.name, slot, isBot: false };
  delete room.requests[playerId];
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true, slot });
});

// ── POST /rooms/:code/reject ──────────────────────────────────
// Host rejects a player request
app.post('/rooms/:code/reject', (req, res) => {
  const { hostId, playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  delete room.requests[playerId];
  broadcastRoomUpdate(req.params.code);

  // Notify the rejected player directly
  const sockId = playerConnections.get(playerId);
  sendToSocket(sockId, { type: 'REJECTED', roomCode: req.params.code });

  res.json({ success: true });
});

// ── POST /rooms/:code/start ───────────────────────────────────
// Host starts the game; fills empty slots with bots
app.post('/rooms/:code/start', (req, res) => {
  const { hostId, sessionId } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  // Fill empty slots with bots
  const occupiedSlots = getOccupiedSlots(room.players);
  for (let i = 0; i < 4; i++) {
    if (!occupiedSlots.includes(i)) {
      room.players[`BOT_${i}`] = { name: 'Bot', slot: i, isBot: true };
    }
  }

  room.status = 'PLAYING';
  room.sessionId = sessionId || crypto.randomUUID();
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true, sessionId: room.sessionId });
});

// ── DELETE /rooms/:code ───────────────────────────────────────
// Host deletes room OR player leaves room
app.delete('/rooms/:code', (req, res) => {
  const { playerId, isHost } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.json({ success: true }); // Already deleted

  if (isHost || room.hostId === playerId) {
    broadcastToRoom(req.params.code, {
      type: 'ROOM_DELETED',
      reason: 'Host closed the room',
    });
    rooms.delete(req.params.code);
  } else {
    delete room.players[playerId];
    delete room.requests[playerId];
    delete room.audiences[playerId];
    broadcastRoomUpdate(req.params.code);
  }
  res.json({ success: true });
});

// ── POST /rooms/:code/bot ─────────────────────────────────────
// Host adds or removes a bot from a slot
app.post('/rooms/:code/bot', (req, res) => {
  const { hostId, slot, action } = req.body; // action: 'add' | 'remove'
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  if (action === 'add') {
    room.players[`BOT_${slot}`] = { name: 'Bot', slot: Number(slot), isBot: true };
  } else if (action === 'remove') {
    delete room.players[`BOT_${slot}`];
  }

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ── POST /rooms/:code/swap ────────────────────────────────────
// Host swaps two players' slots
app.post('/rooms/:code/swap', (req, res) => {
  const { hostId, playerId1, playerId2 } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  const p1 = room.players[playerId1];
  const p2 = room.players[playerId2];
  if (!p1) return res.status(400).json({ error: `Player ${playerId1} not found` });
  if (!p2) return res.status(400).json({ error: `Player ${playerId2} not found` });

  const tempSlot = p1.slot;
  p1.slot = p2.slot;
  p2.slot = tempSlot;

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ── POST /rooms/:code/promote ─────────────────────────────────
// Host promotes an audience member to replace a bot
app.post('/rooms/:code/promote', (req, res) => {
  const { hostId, audienceId, audienceName, slot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  delete room.players[`BOT_${slot}`];
  delete room.audiences[audienceId];
  room.players[audienceId] = { name: audienceName, slot: Number(slot), isBot: false };

  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});

// ── POST /rooms/:code/replace_bot ────────────────────────────
// Host replaces a disconnected player's slot with a bot (called after timeout)
app.post('/rooms/:code/replace_bot', (req, res) => {
  const { hostId, slot } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== hostId) return res.status(403).json({ error: 'Not the host' });

  // Remove any existing player in this slot
  Object.keys(room.players).forEach(pid => {
    if (room.players[pid].slot === Number(slot) && pid.startsWith('BOT_')) {
      delete room.players[pid];
    }
  });

  room.players[`BOT_${slot}`] = { name: 'Bot', slot: Number(slot), isBot: true };
  broadcastRoomUpdate(req.params.code);
  res.json({ success: true });
});


// ============================================================
// WEBSOCKET SERVER
// ============================================================

wss.on('connection', (ws, req) => {
  const socketId = crypto.randomUUID();
  connections.set(socketId, { ws, playerId: null, roomCode: null, isAudience: false });

  // Welcome message
  ws.send(JSON.stringify({ type: 'CONNECTED', socketId }));

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      handleWsMessage(socketId, msg);
    } catch (err) {
      // Ignore malformed JSON
    }
  });

  ws.on('close', () => {
    handleDisconnect(socketId);
  });

  ws.on('error', (err) => {
    // Log but don't crash the server
    console.error(`[WS Error] socketId=${socketId}:`, err.message);
  });
});

function handleWsMessage(socketId, msg) {
  const conn = connections.get(socketId);
  if (!conn) return;

  switch (msg.type) {

    /**
     * REGISTER — Associate this socket with a player and room
     * Sent by Flutter client immediately after WebSocket connects.
     * {type:'REGISTER', playerId, roomCode, isAudience}
     */
    case 'REGISTER': {
      const { playerId, roomCode, isAudience } = msg;
      if (!playerId || !roomCode) break;

      // Remove any stale socket for this player
      const oldSocketId = playerConnections.get(playerId);
      if (oldSocketId && oldSocketId !== socketId) {
        const oldConn = connections.get(oldSocketId);
        if (oldConn) oldConn.roomCode = null; // Detach old connection
      }

      conn.playerId = playerId;
      conn.roomCode = roomCode;
      conn.isAudience = isAudience || false;
      playerConnections.set(playerId, socketId);

      ws_send(conn.ws, { type: 'REGISTERED', playerId, roomCode });
      break;
    }

    /**
     * GAME_MSG — Route a game message to the correct recipient(s)
     * {type:'GAME_MSG', sender, target, data, sessionId}
     * target: "ALL" | "HOST" | specific playerId
     */
    case 'GAME_MSG': {
      const roomCode = conn.roomCode;
      if (!roomCode) break;

      const sender = msg.sender || conn.playerId;
      routeGameMessage(roomCode, sender, msg.target, msg.data, msg.sessionId);
      break;
    }

    /**
     * PING — Keepalive ping (prevents Render.com from sleeping)
     * {type:'PING'}
     */
    case 'PING': {
      ws_send(conn.ws, { type: 'PONG', timestamp: Date.now() });
      break;
    }

    default:
      break;
  }
}

function handleDisconnect(socketId) {
  const conn = connections.get(socketId);
  if (!conn) return;

  const { playerId, roomCode, isAudience } = conn;

  if (playerId) {
    // Only clean up if this socket is still the current one for this player
    if (playerConnections.get(playerId) === socketId) {
      playerConnections.delete(playerId);
    }

    if (roomCode) {
      const room = rooms.get(roomCode);
      if (room) {
        if (isAudience) {
          // Audience disconnect: just remove them, no critical impact
          delete room.audiences[playerId];
          broadcastRoomUpdate(roomCode);
        } else if (room.hostId === playerId) {
          // HOST disconnected: start a grace period timer
          // If host doesn't reconnect within 60 seconds, delete the room
          setTimeout(() => {
            const currentSocketId = playerConnections.get(playerId);
            if (!currentSocketId) {
              // Host never reconnected
              if (rooms.has(roomCode)) {
                broadcastToRoom(roomCode, {
                  type: 'ROOM_DELETED',
                  reason: 'Host disconnected',
                });
                rooms.delete(roomCode);
              }
            }
          }, 60 * 1000);
        } else {
          // Regular player disconnected: notify the host
          // Host Flutter client handles the 15-second bot replacement timer
          const hostSocketId = playerConnections.get(room.hostId);
          if (hostSocketId) {
            sendToSocket(hostSocketId, {
              type: 'GAME_MSG',
              sender: 'SERVER',
              data: `PLAYER_DISCONNECTED:${playerId}`,
              sessionId: room.sessionId || '',
              roomCode,
            });
          }
        }
      }
    }
  }

  connections.delete(socketId);
}

// Tiny helper to avoid repetition
function ws_send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}


// ============================================================
// ROOM CLEANUP: Remove stale rooms older than 4 hours
// ============================================================
setInterval(() => {
  const maxAgeMs = 4 * 60 * 60 * 1000; // 4 hours
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (now - room.createdAt > maxAgeMs) {
      rooms.delete(code);
    }
  });
}, 30 * 60 * 1000); // Run every 30 minutes


// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(` Game 29 Server`);
  console.log(` HTTP + WebSocket on port ${PORT}`);
  console.log(` Health: http://localhost:${PORT}/health`);
  console.log(`========================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  httpServer.close(() => process.exit(0));
});
