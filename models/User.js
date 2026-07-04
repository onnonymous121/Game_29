const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  name: { type: String, default: 'Guest Player' },
  nickname: { type: String, default: null }, 
  lastNicknameChange: { type: Date, default: null }, 
  coins: { type: Number, default: 5000 }, 
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  
  // ── অ্যাড লিমিটেশন এবং ট্র্যাকিং ──
  dailyAdCount: { type: Number, default: 0 },
  lastAdDate: { type: Date, default: null },

  game29Stats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 }
  },
  // ── নতুন গেমগুলোর স্ট্যাটাস ──
  ludoStats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 }
  },
  callBreakStats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 }
  },
  
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);