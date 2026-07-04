require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { parse } = require('url');

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const serviceAccount = require('./serviceAccountKey.json');
initializeApp({ credential: cert(serviceAccount) });

const User = require('./models/User');
const roomManager = require('./roomManager');

const app = express();
app.use(express.json());
app.use(cors());

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

app.post('/api/login', async (req, res) => {
  const { idToken, authType, guestName } = req.body;
  try {
    let uid, name;
    if (authType === 'Google') {
      const decodedToken = await getAuth().verifyIdToken(idToken);
      uid = decodedToken.uid;
      name = decodedToken.name || 'Google Player';
    } else {
      uid = idToken; 
      name = guestName || 'Guest Player';
    }

    let user = await User.findOne({ uid: uid });
    if (!user) {
      user = new User({ uid: uid, name: name, coins: 5000, level: 1, xp: 0 });
      await user.save();
    }

    const responseUser = user.toObject();
    responseUser.name = user.nickname ? user.nickname : user.name;

    res.json({ success: true, user: responseUser });
  } catch (error) {
    res.status(500).json({ error: 'Authentication Failed' });
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

// ── নতুন API: প্লেয়ারদের মধ্যে কয়েন ট্রান্সফার ──
app.post('/api/transfer-coins', async (req, res) => {
  const { senderUid, receiverUid, amount } = req.body;
  
  try {
    const transferAmount = parseInt(amount, 10);

    if (!transferAmount || transferAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }
    if (senderUid === receiverUid) {
      return res.status(400).json({ error: 'You cannot send coins to yourself.' });
    }

    const sender = await User.findOne({ uid: senderUid });
    const receiver = await User.findOne({ uid: receiverUid });

    if (!sender) return res.status(404).json({ error: 'Sender not found.' });
    if (!receiver) return res.status(404).json({ error: 'Receiver not found. Check the UID.' });

    if (sender.coins < transferAmount) {
      return res.status(400).json({ error: 'Insufficient coins.' });
    }

    // ব্যালেন্স আপডেট
    sender.coins -= transferAmount;
    receiver.coins += transferAmount;

    await sender.save();
    await receiver.save();

    res.json({ 
      success: true, 
      message: `Successfully sent ${transferAmount} coins to ${receiver.nickname || receiver.name}!`,
      senderCoins: sender.coins 
    });
  } catch (error) {
    res.status(500).json({ error: 'Transfer Failed due to a server error.' });
  }
});

// ফ্রন্টএন্ডের সুবিধার জন্য গ্লোবাল রাউটার মাউন্ট করা হলো
app.use('/game29', roomManager.router);

app.get('/', (req, res) => res.send('Global Game Hub Server Running!'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Running on Port ${PORT}`);
});