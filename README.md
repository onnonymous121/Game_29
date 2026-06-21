# Game 29 — Free Backend API System

Complete WebSocket + HTTP REST backend to replace Firebase.  
**Totally free.** No credit card. No account verification.

---

## Contents

| File | Purpose |
|------|---------|
| `server.js` | Main Node.js server (Express HTTP + ws WebSocket) |
| `package.json` | Node.js dependencies |
| `render.yaml` | Render.com deployment config |
| `api_service.dart` | Flutter client service — copy to `lib/core/services/` |

---

## Free Deployment (Render.com) — Recommended

### Why Render.com?
- 750 free hours/month (enough for 24/7)
- Native Node.js support with WebSocket
- No credit card required
- Auto-deploys from GitHub on every push
- Free HTTPS/WSS certificates included
- Custom domain support

### Step-by-Step Deployment

#### Step 1 — Create a GitHub Repository
1. Go to [github.com](https://github.com) and create a free account (if you don't have one)
2. Create a new **public** repository named `game29-server`
3. Upload these files to the repository:
   ```
   game29-server/
   ├── server.js
   ├── package.json
   └── render.yaml
   ```

   Using GitHub web UI:
   - Click "Add file" → "Create new file"
   - Paste the contents of each file
   - Commit each file

#### Step 2 — Create a Render Account
1. Go to [render.com](https://render.com)
2. Click **"Get Started for Free"**
3. Sign up with your GitHub account (easiest — no separate verification)

#### Step 3 — Deploy the Server
1. In Render dashboard, click **"New"** → **"Web Service"**
2. Click **"Connect account"** → authorize GitHub
3. Select your `game29-server` repository
4. Render will auto-detect the `render.yaml` file
5. Settings (auto-filled from render.yaml, verify these):
   - **Name:** game29-server
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
6. Click **"Create Web Service"**
7. Wait 2-3 minutes for the build to complete
8. Your server URL will be: `https://game29-server.onrender.com`

#### Step 4 — Test the Server
Open this URL in your browser:
```
https://game29-server.onrender.com/health
```
You should see:
```json
{"status":"ok","rooms":0,"connections":0,"uptime":120}
```

#### Step 5 — Update Flutter App
1. Copy `api_service.dart` to your Flutter project: `lib/core/services/api_service.dart`
2. Open `api_service.dart` and update the URL constants:
   ```dart
   static const String _baseUrl = 'https://game29-server.onrender.com';
   static const String _wsUrl   = 'wss://game29-server.onrender.com/ws';
   ```
3. Add dependencies to `pubspec.yaml`:
   ```yaml
   dependencies:
     http: ^1.2.0
     web_socket_channel: ^3.0.1
   ```
4. Run `flutter pub get`

---

## Alternative: Railway.app

If you prefer Railway.app:

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click **"New Project"** → **"Deploy from GitHub repo"**
4. Select your `game29-server` repo
5. Railway auto-detects Node.js and deploys
6. Free tier: $5 credit/month (~500 hours)
7. Get your URL from: Project → Settings → Domains

---

## Alternative: Fly.io (Always-On Free Tier)

Fly.io offers 3 always-on free VMs — no sleep:

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Inside the api_system/ folder:
flyctl launch --name game29-server --no-deploy
flyctl deploy
```

Your server will be at: `https://game29-server.fly.dev`

---

## Local Testing (Android Device)

For testing on a physical Android device connected to the same WiFi:

1. Start the server locally:
   ```bash
   cd api_system/
   npm install
   node server.js
   ```

2. Find your computer's local IP:
   ```bash
   # Windows:
   ipconfig
   # Linux/Mac:
   ip addr show | grep inet
   ```

3. Update `api_service.dart`:
   ```dart
   static const String _baseUrl = 'http://192.168.1.x:3000';  // Your IP
   static const String _wsUrl   = 'ws://192.168.1.x:3000/ws';
   ```

4. For Android emulator, use:
   ```dart
   static const String _baseUrl = 'http://10.0.2.2:3000';
   static const String _wsUrl   = 'ws://10.0.2.2:3000/ws';
   ```

---

## Important: Free Tier Sleep Behavior (Render.com)

Render.com free tier **sleeps** the server after 15 minutes of inactivity.  
The server wakes up automatically when the first request arrives, but it takes **20-30 seconds**.

### How the Flutter app handles this:
The `ApiService` class already has:
- WebSocket reconnect logic with 3-second retry
- Automatic re-registration after reconnect
- The `connect()` method is safe to call multiple times

### What users see:
- First connection after a sleep period: "Connecting..." for 20-30 seconds
- Subsequent connections: instant (under 1 second)

### To avoid sleep on Render.com free tier:
Add a scheduled ping to keep the server awake. Use any free service:
- [UptimeRobot](https://uptimerobot.com) — Free, pings your `/health` endpoint every 5 minutes
- Setup: Create account → Add monitor → HTTP → URL: `https://game29-server.onrender.com/health` → Interval: 5 minutes

---

## API Reference

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/rooms` | List all joinable public rooms |
| GET | `/rooms/:code` | Get room details |
| POST | `/rooms/create` | Create a new room |
| POST | `/rooms/:code/join` | Join room (as player or audience) |
| POST | `/rooms/:code/admit` | Host admits a player |
| POST | `/rooms/:code/reject` | Host rejects a player |
| POST | `/rooms/:code/start` | Host starts the game |
| DELETE | `/rooms/:code` | Delete room or leave room |
| POST | `/rooms/:code/bot` | Add/remove bot from slot |
| POST | `/rooms/:code/swap` | Swap two players' slots |
| POST | `/rooms/:code/promote` | Promote audience to player |
| POST | `/rooms/:code/replace_bot` | Replace slot with bot (after disconnect) |

### WebSocket Protocol

Connect to: `wss://your-server.onrender.com/ws`

#### Client → Server messages:
```json
// Register connection to a room
{"type": "REGISTER", "playerId": "player_123", "roomCode": "456789", "isAudience": false}

// Send a game message
{"type": "GAME_MSG", "sender": "player_123", "target": "ALL", "data": "BID_MAKE:20", "sessionId": "uuid"}

// Keepalive
{"type": "PING"}
```

#### Server → Client messages:
```json
// After connecting
{"type": "CONNECTED", "socketId": "uuid"}

// After registering
{"type": "REGISTERED", "playerId": "player_123", "roomCode": "456789"}

// Game messages (routed from other players)
{"type": "GAME_MSG", "sender": "player_456", "data": "BID_INFO:20:2", "sessionId": "uuid", "roomCode": "456789"}

// Room state changed (player joined/left, admitted, game started)
{"type": "ROOM_UPDATE", "roomCode": "456789", "room": {...}}

// Room was deleted by host
{"type": "ROOM_DELETED", "reason": "Host closed the room"}

// Your join request was rejected
{"type": "REJECTED", "roomCode": "456789"}

// A player disconnected (sent only to host)
{"type": "GAME_MSG", "sender": "SERVER", "data": "PLAYER_DISCONNECTED:player_123", ...}

// Keepalive response
{"type": "PONG", "timestamp": 1234567890}
```

---

## Replacing Firebase in Flutter — Code Migration Guide

### main.dart
```dart
// REMOVE these lines:
import 'package:firebase_core/firebase_core.dart';
await Firebase.initializeApp();

// Keep everything else the same
```

### online_lobby_screen.dart — Key replacements

```dart
// OLD (Firebase):
database = FirebaseDatabase.instance.ref();
await database.child("Rooms").child(roomCode).set(roomData);

// NEW (ApiService):
final api = ApiService();
final roomCode = await api.createRoom(
  playerId: myPlayerId,
  playerName: myNickname,
  type: isPublic ? 'public' : 'private',
  allowAudience: allowAudience,
);
```

```dart
// OLD (Firebase real-time listener):
database.child("Rooms").child(roomCode).onValue.listen((event) {
  Map data = event.snapshot.value as Map;
  // handle room update
});

// NEW (WebSocket stream):
await api.connect(roomCode, myPlayerId, isAudience: false);
api.roomUpdates.listen((room) {
  // handle room update — same logic, RoomModel has same fields
});
api.systemEvents.listen((event) {
  if (event == 'ROOM_DELETED') { /* host closed room */ }
  if (event == 'REJECTED') { /* your request was rejected */ }
});
```

### online_game_screen.dart — Key replacements

```dart
// OLD (Firebase send message):
database.child("Rooms").child(roomCode).child("messages").push().set({
  "sender": myPlayerId, "target": target, "data": data, "sessionId": sessionId
});

// NEW (WebSocket):
api.sendGameMsg(target: target, data: data, sessionId: sessionId);
```

```dart
// OLD (Firebase receive messages):
database.child("Rooms").child(roomCode).child("messages").onChildAdded.listen((event) {
  var data = event.snapshot.value as Map;
  String msgData = data["data"];
  String sender = data["sender"];
  processNetworkDataAsync(msgData, sender);
});

// NEW (WebSocket stream):
api.gameMessages.listen((msg) {
  if (msg.sessionId != widget.sessionId) return; // Filter by session
  if (msg.sender == widget.myPlayerId) return;   // Ignore own messages
  processNetworkDataAsync(msg.data, msg.sender);
});
```

---

## Scaling for More Players / Higher Traffic

The current free-tier Node.js server handles approximately:
- **50-100 concurrent players** comfortably
- **500+ rooms** simultaneously (in-memory, no DB)
- **Messages**: Limited only by network bandwidth

To scale beyond free tier:
1. **Add Redis** for room persistence across restarts (Redis free tier on Upstash)
2. **Deploy multiple instances** behind a load balancer (requires session affinity for WebSockets)
3. **Use Cloudflare Durable Objects** ($5/month Workers plan) for global edge distribution

---

*Game 29 API System — Generated 2026-06-12*
