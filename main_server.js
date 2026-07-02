require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { parse } = require('url');

// ফায়ারবেস অ্যাডমিন (নতুন মডুলার পদ্ধতি)
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

// Service Account Key ইমপোর্ট এবং ফায়ারবেস ইনিশিয়ালাইজেশন
const serviceAccount = require('./serviceAccountKey.json');
initializeApp({
  credential: cert(serviceAccount)
});

// ইউজারের ডাটাবেস মডেল ইমপোর্ট
const User = require('./models/User');

// Game 29 মডিউল ইমপোর্ট (ফোল্ডারের নাম অনুযায়ী পাথ নিশ্চিত করুন)
const game29Module = require('./games/game_29');

const app = express();
app.use(express.json());
app.use(cors());

const httpServer = createServer(app);

// ============================================================
// MongoDB কানেকশন সেটআপ
// ============================================================
// .env ফাইল থেকে URL নিচ্ছে, অথবা ডিফল্ট হিসেবে আপনার দেওয়া URL
const mongoURI = process.env.MONGO_URI || 'mongodb+srv://aabufaraje_db_user:fkcwg1ErSAU9dTa7@game29.mxv9ojn.mongodb.net/myGameDb?appName=Game29';

mongoose.connect(mongoURI)
.then(() => console.log('✅ MongoDB Database Connected Successfully!'))
.catch((err) => console.error('❌ MongoDB Connection Error:', err));

// ============================================================
// Centralized WebSocket Server
// ============================================================
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const { pathname } = parse(request.url);

  // পাথ অনুযায়ী ট্রাফিক নির্দিষ্ট গেম মডিউলে পাঠানো হচ্ছে
  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === '/ws/game29') {
      game29Module.handleConnection(ws);
    } else {
      ws.close();
    }
  });
});

// ============================================================
// API: User Login / Authentication
// ============================================================
app.post('/api/login', async (req, res) => {
  const { idToken, authType, guestName } = req.body;

  try {
    let uid, name;

    if (authType === 'Google') {
      // ফায়ারবেস টোকেন ভেরিফাই করা (নতুন পদ্ধতি)
      const decodedToken = await getAuth().verifyIdToken(idToken);
      uid = decodedToken.uid;
      name = decodedToken.name || 'Google Player';
    } else if (authType === 'Guest') {
      // গেস্ট ইউজারদের জন্য
      uid = idToken; 
      name = guestName || 'Guest Player';
    } else {
      return res.status(400).json({ error: 'Invalid auth type' });
    }

    // মঙ্গোডিবিতে ইউজার চেক করা
    let user = await User.findOne({ uid: uid });

    // ইউজার না থাকলে নতুন প্রোফাইল তৈরি করা
    if (!user) {
      user = new User({
        uid: uid,
        name: name,
        coins: 5000, // ওয়েলকাম বোনাস
        level: 1,
      });
      await user.save();
      console.log(`🆕 New User Created: ${name}`);
    } else {
      console.log(`👋 User Logged In: ${user.name}`);
    }

    res.json({ success: true, user: user });

  } catch (error) {
    console.error('Login API Error:', error);
    res.status(500).json({ error: 'Authentication Failed' });
  }
});

// ============================================================
// API: Update Guest Name
// ============================================================
app.post('/api/update-name', async (req, res) => {
  const { uid, newName } = req.body;
  try {
    const user = await User.findOneAndUpdate({ uid }, { name: newName }, { new: true });
    if (user) {
      res.json({ success: true, user });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Update Failed' });
  }
});

// ============================================================
// Route HTTP requests to modules
// ============================================================
// Game 29 এর সমস্ত রিকোয়েস্ট /game29 দিয়ে শুরু হবে
app.use('/game29', game29Module.router);

app.get('/', (req, res) => {
  res.send('Welcome to the Global Game Hub Server!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// ============================================================
// Start Server
// ============================================================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(`🚀 Main Game Hub Server Running`);
  console.log(`🌐 Port: ${PORT}`);
  console.log('========================================');
});