const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true }, // ফায়ারবেস থেকে পাওয়া আইডি বা গেস্ট আইডি
  name: { type: String, default: 'Guest Player' }, // ব্যবহারকারীর আসল নাম
  nickname: { type: String, default: 'Guest Player' }, // গেম খেলার সময় অন্য প্লেয়াররা এই নাম দেখবে
  coins: { type: Number, default: 5000 }, // গেম শুরু করার জন্য ৫০০০ ফ্রি কয়েন
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  isPremium: { type: Boolean, default: false }, // প্রিমিয়াম ইউজার কি না তা চেক করার জন্য
  game29Stats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);