require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { parse } = require('url');

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

// ── NEW: Agora Token Builder Import ──
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const serviceAccount = require('./serviceAccountKey.json');
initializeApp({ credential: cert(serviceAccount) });

const User = require('./models/User');
const roomManager = require('./roomManager');

const app = express();
app.use(express.json());
app.use(cors());

// ── DEEP LINKING VERIFICATION (game.omnisent.me) ──
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.json([{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.omnisent.game29",
      "sha256_cert_fingerprints": [
        "FA:07:54:16:04:82:C8:D4:86:47:7C:AD:0A:AA:47:53:F7:61:C4:FB:2A:EB:D9:55:30:23:E0:49:AF:75:3D:84",
        "A5:65:AE:A3:D2:A3:66:FC:40:19:5C:64:8D:F0:9A:6F:21:E6:54:4F:E0:7C:CC:71:0E:E8:50:05:2C:EE:E0:7B"
      ]
    }
  }]);
});

app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    "applinks": {
      "apps": [],
      "details": [{
        "appID": "YOUR_TEAM_ID.com.omnisent.game29", 
        "paths": ["/join/*"]
      }]
    }
  });
});

const httpServer = createServer(app);

const mongoURI = process.env.MONGO_URI || 'mongodb+srv://aabufaraje_db_user:fkcwg1ErSAU9dTa7@game29.mxv9ojn.mongodb.net/myGameDb?appName=Game29';

mongoose.connect(mongoURI)
.then(() => console.log('✅ MongoDB Database Connected Successfully!'))
.catch((err) => console.error('❌ MongoDB Connection Error:', err));

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const { pathname } = parse(request.url);
  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === '/ws/game29' || pathname === '/ws/games') {
      roomManager.handleConnection(ws);
    } else {
      ws.close();
    }
  });
});

// ── NEW: Agora Token Generation API ──
app.post('/api/agora-token', (req, res) => {
  const { channelName } = req.body;
  if (!channelName) {
    return res.status(400).json({ error: 'channelName is required' });
  }

  const appID = "a179da78d81548e38972f8594d3b75de";
  const appCertificate = "3071a080816b491895e3a3fdb8a6f10b";
  const role = RtcRole.PUBLISHER;
  const expirationTimeInSeconds = 3600; 
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      appID, 
      appCertificate, 
      channelName, 
      0, 
      role, 
      privilegeExpiredTs
    );
    
    res.json({ success: true, token: token });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// ── Real-time Username Check API ──
app.post('/api/check-username', async (req, res) => {
  const { username } = req.body;
  try {
    if (!username) return res.json({ available: false });
    const existingUsername = await User.findOne({ nickname: username });
    if (existingUsername) {
      res.json({ available: false }); // Taken
    } else {
      res.json({ available: true }); // Available
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Updated Login API ──
app.post('/api/login', async (req, res) => {
  const { idToken, authType, fullName, userName } = req.body;
  try {
    let uid, name;
    
    if (authType === 'Google' || authType === 'Email') {
      const decodedToken = await getAuth().verifyIdToken(idToken);
      uid = decodedToken.uid;
      name = fullName || decodedToken.name || 'Player';
    } else {
      return res.status(400).json({ error: 'Invalid authType' });
    }

    let user = await User.findOne({ uid: uid });
    
    if (!user) {
      if (userName) {
        const existingUsername = await User.findOne({ nickname: userName });
        if (existingUsername) {
          return res.status(400).json({ error: 'Username already taken. Please choose another.' });
        }
      }

      user = new User({ uid: uid, name: name, coins: 5000, level: 1, xp: 0 });
      if (userName) {
        user.nickname = userName;
      }
      await user.save();
    } else {
      if (userName && !user.nickname) {
        const existingUsername = await User.findOne({ nickname: userName });
        if (!existingUsername) {
          user.nickname = userName;
          await user.save();
        }
      }
    }

    const responseUser = user.toObject();
    responseUser.name = user.name;
    responseUser.nickname = user.nickname || user.name;

    res.json({ success: true, user: responseUser });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Authentication Failed' });
  }
});

// ── Profile & Stats / Rank API ──
app.post('/api/user-stats', async (req, res) => {
  const { uid } = req.body;
  try {
    const user = await User.findOne({ uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const higherRankCount = await User.countDocuments({ 
      $expr: { $gt: [{ $add: ["$xp", { $multiply: ["$level", 1000] }] }, (user.xp + user.level * 1000)] } 
    });
    const userRank = higherRankCount + 1;

    const topPlayer = await User.findOne().sort({ xp: -1, level: -1, coins: -1 });

    res.json({
      success: true,
      stats: {
        nickname: user.nickname || user.name,
        level: user.level,
        xp: user.xp,
        coins: user.coins,
        game29: user.game29Stats,
        ludo: user.ludoStats,
        callBreak: user.callBreakStats,
        rank: userRank,
        topPlayerName: topPlayer ? (topPlayer.nickname || topPlayer.name) : 'N/A',
        topPlayerXp: topPlayer ? topPlayer.xp : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

// ── Delete Account API ──
app.post('/api/delete-account', async (req, res) => {
  const { uid } = req.body;
  try {
    await User.findOneAndDelete({ uid });
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

app.post('/api/update-name', async (req, res) => {
  const { uid, newNickname } = req.body;
  try {
    const user = await User.findOne({ uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.lastNicknameChange) {
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - new Date(user.lastNicknameChange).getTime() < oneWeek) {
        return res.status(400).json({ error: 'You can only change your nickname once per week.' });
      }
    }

    const existing = await User.findOne({ nickname: newNickname });
    if (existing) return res.status(400).json({ error: 'Nickname already taken!' });

    user.nickname = newNickname;
    user.lastNicknameChange = new Date();
    await user.save();

    res.json({ success: true, nickname: user.nickname });
  } catch (error) {
    res.status(500).json({ error: 'Update Failed' });
  }
});

app.post('/api/reward-coins', async (req, res) => {
  const { uid } = req.body;
  try {
    const user = await User.findOne({ uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const DAILY_AD_LIMIT = 10; 
    const REWARD_COINS = 250;  
    const now = new Date();

    if (user.lastAdDate) {
      const lastDate = new Date(user.lastAdDate);
      if (lastDate.toDateString() !== now.toDateString()) {
        user.dailyAdCount = 0;
      }
    }

    if (user.dailyAdCount >= DAILY_AD_LIMIT) {
      return res.status(400).json({ error: 'Daily ad limit reached. Come back tomorrow!' });
    }

    user.coins += REWARD_COINS;
    user.dailyAdCount += 1;
    user.lastAdDate = now;
    await user.save();

    res.json({ 
      success: true, 
      coins: user.coins, 
      dailyAdCount: user.dailyAdCount,
      message: `Earned ${REWARD_COINS} coins!`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process reward' });
  }
});

app.use('/game29', roomManager.router);

app.get('/', (req, res) => res.send('Global Game Hub Server Running!'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Running on Port ${PORT}`);
});