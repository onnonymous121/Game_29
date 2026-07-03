const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  name: { type: String, default: 'Guest Player' }, // জিমেইল/অরিজিনাল নাম
  nickname: { type: String, default: null }, // ইউজার সেট করা ইউনিক নাম
  lastNicknameChange: { type: Date, default: null }, // নাম পরিবর্তনের সময় ট্র্যাক করার জন্য
  coins: { type: Number, default: 5000 },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  game29Stats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);