const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true }, // ফায়ারবেস থেকে পাওয়া আইডি বা গেস্ট আইডি
  name: { type: String, default: 'Guest Player' },
  coins: { type: Number, default: 5000 }, // গেম শুরু করার জন্য ৫০০০ ফ্রি কয়েন
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  game29Stats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);