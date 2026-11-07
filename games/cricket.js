/**
 * Server-Side Audio Cricket Game Engine (games/cricket.js)
 * ============================================================================
 * Features:
 * - Fast & Crisp Audio Messages (Zero TTS Lag)
 * - Bowler & Batter "Are You Ready?" Interactive Handshake
 * - Broadcasted 3D Bowler Run-up Audio (Panning based on Off/Middle/Leg line)
 * - 5-Second Ping-Pong Keep-Alive Support & Full State Recovery on SYNC_STATE
 * - Dynamic Overs, ICC Bowler Quota, DRS Review & 3D Fielding Mechanics
 */

'use strict';

const cricketRoomManager = require('../cricketRoomManager');

// Standard Fielding Positions with Audio Angle (-1.0 Left/Off to +1.0 Right/Leg) & Depth
const FIELDING_POSITIONS = {
  'wicketkeeper': { name: 'Keeper', pan: 0.0, depth: 'close' },
  'slip':         { name: 'Slip', pan: -0.35, depth: 'close' },
  'gully':        { name: 'Gully', pan: -0.65, depth: 'close' },
  'point':        { name: 'Point', pan: -0.90, depth: 'inner' },
  'cover':        { name: 'Cover', pan: -0.60, depth: 'inner' },
  'mid_off':      { name: 'Mid Off', pan: -0.25, depth: 'inner' },
  'mid_on':       { name: 'Mid On', pan: 0.25, depth: 'inner' },
  'mid_wicket':   { name: 'Mid Wicket', pan: 0.65, depth: 'inner' },
  'square_leg':   { name: 'Square Leg', pan: 0.90, depth: 'inner' },
  'fine_leg':     { name: 'Fine Leg', pan: 0.45, depth: 'boundary' },
  'third_man':    { name: 'Third Man', pan: -0.45, depth: 'boundary' },
  'long_off':     { name: 'Long Off', pan: -0.30, depth: 'boundary' },
  'long_on':      { name: 'Long On', pan: 0.30, depth: 'boundary' },
  'deep_cover':   { name: 'Deep Cover', pan: -0.80, depth: 'boundary' },
  'deep_mid_wicket': { name: 'Deep Mid Wicket', pan: 0.80, depth: 'boundary' }
};

const DEFAULT_FIELD_ORDER = [
  'wicketkeeper', 'slip', 'point', 'cover', 'mid_off',
  'mid_on', 'mid_wicket', 'square_leg', 'fine_leg', 'third_man', 'long_on'
];

// ============================================================
// INITIALIZE MATCH
// ============================================================
function initGame(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room) return;

  const totalOvers = Number(room.overs) || 5;

  const g = {
    roomCode,
    playMode: room.playMode, // 'team' or 'individual'
    totalOvers,
    maxOversPerBowler: (room.playMode === 'individual') ? totalOvers : Math.max(1, Math.ceil(totalOvers / 5)),
    minSpinOvers: totalOvers >= 20 ? 6 : (totalOvers >= 10 ? 3 : 0),
    minPaceOvers: totalOvers >= 20 ? 6 : (totalOvers >= 10 ? 3 : 0),

    innings: 1,
    phase: 'TOSS',

    tossWinnerTeam: null,
    battingTeam: 'A',
    bowlingTeam: 'B',

    // Scoreboard State
    score: 0,
    wickets: 0,
    maxWickets: 1,
    ballsBowledInInnings: 0,
    ballsInCurrentOver: 0,
    runsInCurrentOver: 0,
    target: null,
    firstInningsSummary: null,

    // Active On-Field Roles (Slot numbers)
    strikerSlot: -1,
    nonStrikerSlot: -1,
    currentBowlerSlot: -1,
    lastOverBowlerSlot: -1,
    currentBowlerStyle: 'fast',

    // Ready Handshake State
    isBatterReady: false,
    waitingForBatterReady: false,

    // Per-Player Match Statistics & Status
    batsmanStats: {},
    bowlerStats: {},
    fieldingMap: {},

    // Team Quota Tracking
    paceOversBowled: 0,
    spinOversBowled: 0,

    // International DRS Reviews (2 per innings per team)
    reviewsLeft: { A: 2, B: 2 },

    // Current Ball Physics & DRS Truth Data
    currentDelivery: null,
    pendingDismissal: null,
    drsTimer: null,
    botActionTimer: null,
  };

  room.game = g;
  initPlayerStatsAndDefaultPositions(room, g);

  cricketRoomManager.gameEvent(roomCode, 'MATCH_INIT', {
    teamAName: room.teamAName,
    teamBName: room.teamBName,
    overs: g.totalOvers,
    maxOversPerBowler: g.maxOversPerBowler,
    playMode: g.playMode,
    soundCue: 'stadium_welcome_roar',
    message: `${room.teamAName} vs ${room.teamBName}. ${g.totalOvers} overs.`
  });

  // Perform toss after 1.5s so clients have completed screen transition
  setTimeout(() => performToss(roomCode), 1500);
}

function getTeamSlots(room, team) {
  const allSlots = Object.values(room.players).map(p => p.slot).sort((a, b) => a - b);
  if (room.playMode === 'individual') {
    return team === 'A' ? allSlots.filter(s => s === 0) : allSlots.filter(s => s === 1);
  }
  return team === 'A' ? allSlots.filter(s => s < 11) : allSlots.filter(s => s >= 11);
}

function getPlayerNameBySlot(room, slot) {
  const entry = Object.values(room.players).find(p => p.slot === slot);
  return entry ? entry.name : `P${slot + 1}`;
}

function isSlotBot(room, slot) {
  const entry = Object.values(room.players).find(p => p.slot === slot);
  return entry ? !!entry.isBot : true;
}

function getCaptainSlot(room, team) {
  const slots = getTeamSlots(room, team);
  if (slots.length === 0) return -1;
  if (team === 'A') {
    const hostPlayer = room.players[room.hostId];
    return hostPlayer ? hostPlayer.slot : slots[0];
  } else {
    if (room.captainBId && room.players[room.captainBId]) {
      return room.players[room.captainBId].slot;
    }
    return slots[0];
  }
}

function initPlayerStatsAndDefaultPositions(room, g) {
  g.batsmanStats = {};
  g.bowlerStats = {};
  g.fieldingMap = {};

  const allSlots = Object.values(room.players).map(p => p.slot);
  allSlots.forEach((slot, idx) => {
    g.batsmanStats[slot] = {
      slot,
      name: getPlayerNameBySlot(room, slot),
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      status: 'yet_to_bat',
      outDesc: ''
    };
    g.bowlerStats[slot] = {
      slot,
      name: getPlayerNameBySlot(room, slot),
      balls: 0,
      oversCompleted: 0,
      maidens: 0,
      runsConceded: 0,
      wickets: 0,
      style: (idx % 2 === 0) ? 'fast' : 'spin'
    };
  });
}

function setupDefaultInningsRoles(room, g) {
  const batSlots = getTeamSlots(room, g.battingTeam);
  const bowlSlots = getTeamSlots(room, g.bowlingTeam);

  g.maxWickets = batSlots.length <= 1 ? 1 : batSlots.length;
  g.paceOversBowled = 0;
  g.spinOversBowled = 0;
  g.reviewsLeft = { A: 2, B: 2 };

  batSlots.forEach(s => {
    g.batsmanStats[s] = {
      slot: s,
      name: getPlayerNameBySlot(room, s),
      runs: 0, balls: 0, fours: 0, sixes: 0,
      status: 'yet_to_bat', outDesc: ''
    };
  });
  bowlSlots.forEach((s, i) => {
    g.bowlerStats[s] = {
      slot: s,
      name: getPlayerNameBySlot(room, s),
      balls: 0, oversCompleted: 0, maidens: 0, runsConceded: 0, wickets: 0,
      style: (i % 2 === 0) ? 'fast' : 'spin'
    };
    const posKey = DEFAULT_FIELD_ORDER[i % DEFAULT_FIELD_ORDER.length];
    g.fieldingMap[s] = posKey;
  });

  g.strikerSlot = batSlots[0];
  g.batsmanStats[g.strikerSlot].status = 'batting';

  if (batSlots.length > 1) {
    g.nonStrikerSlot = batSlots[1];
    g.batsmanStats[g.nonStrikerSlot].status = 'batting';
  } else {
    g.nonStrikerSlot = -1;
  }

  g.maxOversPerBowler = bowlSlots.length <= 1
    ? g.totalOvers
    : Math.max(1, Math.ceil(g.totalOvers / Math.min(5, bowlSlots.length)));

  g.currentBowlerSlot = bowlSlots[0];
  g.lastOverBowlerSlot = -1;
  g.currentBowlerStyle = g.bowlerStats[g.currentBowlerSlot]?.style || 'fast';
}

// ============================================================
// TOSS & INNINGS START
// ============================================================
function performToss(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  g.tossWinnerTeam = Math.random() < 0.5 ? 'A' : 'B';
  const winnerCapSlot = getCaptainSlot(room, g.tossWinnerTeam);
  const winnerTeamName = g.tossWinnerTeam === 'A' ? room.teamAName : room.teamBName;

  cricketRoomManager.gameEvent(roomCode, 'TOSS_RESULT', {
    tossWinnerTeam: g.tossWinnerTeam,
    winnerTeamName,
    captainSlot: winnerCapSlot,
    soundCue: 'coin_toss',
    message: `${winnerTeamName} won toss.`
  });

  if (isSlotBot(room, winnerCapSlot)) {
    setTimeout(() => handleTossDecision(roomCode, Math.random() < 0.5 ? 'BAT' : 'BOWL'), 1500);
  }
}

function handleTossDecision(roomCode, choice) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;
  if (g.phase !== 'TOSS') return;

  if (!g.tossWinnerTeam) g.tossWinnerTeam = 'A';

  if (choice === 'BAT') {
    g.battingTeam = g.tossWinnerTeam;
    g.bowlingTeam = g.tossWinnerTeam === 'A' ? 'B' : 'A';
  } else {
    g.bowlingTeam = g.tossWinnerTeam;
    g.battingTeam = g.tossWinnerTeam === 'A' ? 'B' : 'A';
  }

  const batTeamName = g.battingTeam === 'A' ? room.teamAName : room.teamBName;
  const bowlTeamName = g.bowlingTeam === 'A' ? room.teamAName : room.teamBName;

  setupDefaultInningsRoles(room, g);

  cricketRoomManager.gameEvent(roomCode, 'INNINGS_STARTED', {
    innings: g.innings,
    battingTeam: g.battingTeam,
    bowlingTeam: g.bowlingTeam,
    battingTeamName: batTeamName,
    bowlingTeamName: bowlTeamName,
    strikerSlot: g.strikerSlot,
    strikerName: getPlayerNameBySlot(room, g.strikerSlot),
    nonStrikerSlot: g.nonStrikerSlot,
    nonStrikerName: g.nonStrikerSlot !== -1 ? getPlayerNameBySlot(room, g.nonStrikerSlot) : 'Runner',
    bowlerSlot: g.currentBowlerSlot,
    bowlerName: getPlayerNameBySlot(room, g.currentBowlerSlot),
    fieldingMap: g.fieldingMap,
    soundCue: 'umpire_play_call',
    message: `${batTeamName} batting. ${getPlayerNameBySlot(room, g.strikerSlot)} on strike.`
  });

  const bowlSlots = getTeamSlots(room, g.bowlingTeam);
  if (bowlSlots.length > 1) {
    promptCaptainForNextBowler(roomCode, true);
  } else {
    startNextBallPrep(roomCode);
  }
}

// ============================================================
// CAPTAIN BOWLER SELECTION (END OF EVERY OVER)
// ============================================================
function promptCaptainForNextBowler(roomCode, isFirstOver = false) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  g.phase = 'SELECT_BOWLER';
  const bowlSlots = getTeamSlots(room, g.bowlingTeam);
  const bowlCaptainSlot = getCaptainSlot(room, g.bowlingTeam);

  const bowlersList = bowlSlots.map(slot => {
    const st = g.bowlerStats[slot];
    const oversBowled = Math.floor(st.balls / 6);
    const ballsRem = st.balls % 6;
    const oversFormatted = `${oversBowled}.${ballsRem}`;
    const oversRemainingQuota = Math.max(0, g.maxOversPerBowler - oversBowled);
    const isConsecutive = (!isFirstOver && bowlSlots.length > 1 && slot === g.lastOverBowlerSlot);
    const canBowl = !isConsecutive && oversRemainingQuota > 0;

    return {
      slot,
      name: getPlayerNameBySlot(room, slot),
      style: st.style,
      figures: `${oversFormatted}-${st.maidens}-${st.runsConceded}-${st.wickets}`,
      oversBowled,
      oversRemainingQuota,
      isConsecutive,
      canBowl
    };
  });

  if (!bowlersList.some(b => b.canBowl)) {
    bowlersList.forEach(b => {
      if (b.slot !== g.lastOverBowlerSlot || bowlSlots.length === 1) b.canBowl = true;
    });
  }

  cricketRoomManager.gameEvent(roomCode, 'OVER_COMPLETE_SELECT_BOWLER', {
    overNumber: Math.floor(g.ballsBowledInInnings / 6) + 1,
    bowlingTeam: g.bowlingTeam,
    captainSlot: bowlCaptainSlot,
    maxOversPerBowler: g.maxOversPerBowler,
    paceOversBowled: g.paceOversBowled,
    spinOversBowled: g.spinOversBowled,
    minPaceOvers: g.minPaceOvers,
    minSpinOvers: g.minSpinOvers,
    bowlersList,
    soundCue: 'umpire_over_call',
    message: isFirstOver
      ? `Select opening bowler.`
      : `Over complete. ${g.score} for ${g.wickets}. Select bowler.`
  });

  if (isSlotBot(room, bowlCaptainSlot)) {
    const eligible = bowlersList.filter(b => b.canBowl);
    const chosen = eligible.length > 0 ? eligible[Math.floor(Math.random() * eligible.length)] : bowlersList[0];
    setTimeout(() => applyBowlerSelection(roomCode, chosen.slot, chosen.style), 1400);
  }
}

function applyBowlerSelection(roomCode, bowlerSlot, styleOverride) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const targetSlot = Number(bowlerSlot);
  if (!g.bowlerStats[targetSlot]) return;

  g.currentBowlerSlot = targetSlot;
  if (styleOverride === 'fast' || styleOverride === 'spin') {
    g.bowlerStats[targetSlot].style = styleOverride;
  }
  g.currentBowlerStyle = g.bowlerStats[targetSlot].style;

  const st = g.bowlerStats[targetSlot];
  const bowlerName = getPlayerNameBySlot(room, targetSlot);

  cricketRoomManager.gameEvent(roomCode, 'BOWLER_SELECTED', {
    bowlerSlot: targetSlot,
    bowlerName,
    style: g.currentBowlerStyle,
    figures: `${Math.floor(st.balls / 6)}.${st.balls % 6}-${st.maidens}-${st.runsConceded}-${st.wickets}`,
    message: `${bowlerName}, ${g.currentBowlerStyle} bowler.`
  });

  setTimeout(() => startNextBallPrep(roomCode), 800);
}

// ============================================================
// BALL PREPARATION, READY HANDSHAKE & BROADCASTED RUN-UP
// ============================================================
function startNextBallPrep(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (checkInningsOrMatchEnd(roomCode)) return;

  g.phase = 'BOWLING_PREP';
  g.currentDelivery = null;
  g.pendingDismissal = null;

  const bowlerIsBot = isSlotBot(room, g.currentBowlerSlot);
  const strikerIsBot = isSlotBot(room, g.strikerSlot);

  // If Striker is a Bot, they are immediately Ready; if Human, wait for Ready handshake!
  g.isBatterReady = strikerIsBot;
  g.waitingForBatterReady = !strikerIsBot;

  const overNum = Math.floor(g.ballsBowledInInnings / 6);
  const ballNum = (g.ballsBowledInInnings % 6) + 1;
  const isCloseMatch = g.innings === 2 && g.target && (g.target - g.score <= 15) && ((g.totalOvers * 6 - g.ballsBowledInInnings) <= 12);

  cricketRoomManager.gameEvent(roomCode, 'BALL_PREP', {
    innings: g.innings,
    score: g.score,
    wickets: g.wickets,
    oversFormatted: `${overNum}.${ballNum - 1}`,
    totalOvers: g.totalOvers,
    target: g.target,
    strikerSlot: g.strikerSlot,
    strikerName: getPlayerNameBySlot(room, g.strikerSlot),
    nonStrikerSlot: g.nonStrikerSlot,
    nonStrikerName: g.nonStrikerSlot !== -1 ? getPlayerNameBySlot(room, g.nonStrikerSlot) : 'Runner',
    bowlerSlot: g.currentBowlerSlot,
    bowlerName: getPlayerNameBySlot(room, g.currentBowlerSlot),
    bowlerStyle: g.currentBowlerStyle,
    isBatterReady: g.isBatterReady,
    fieldingMap: g.fieldingMap,
    reviewsLeft: g.reviewsLeft,
    crowdMood: isCloseMatch ? 'crowd_tense_thriller' : 'crowd_ambient_low',
    message: `${overNum}.${ballNum}: ${getPlayerNameBySlot(room, g.currentBowlerSlot)} to ${getPlayerNameBySlot(room, g.strikerSlot)}.`
  });

  // If Bowler is a Bot:
  if (bowlerIsBot) {
    clearTimeout(g.botActionTimer);
    if (!g.isBatterReady) {
      // Bot Bowler asks human batter "Are you ready?" after 1.2s
      g.botActionTimer = setTimeout(() => {
        if (g.phase === 'BOWLING_PREP' && !g.isBatterReady) {
          handleAskReady(roomCode, g.currentBowlerSlot);
        }
      }, 1200);
    } else {
      scheduleBotRunupAndBowl(roomCode);
    }
  }
}

function handleAskReady(roomCode, senderSlot) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'BOWLING_PREP' || senderSlot !== g.currentBowlerSlot) return;

  g.waitingForBatterReady = true;
  cricketRoomManager.gameEvent(roomCode, 'READY_CHECK_PROMPT', {
    bowlerSlot: g.currentBowlerSlot,
    strikerSlot: g.strikerSlot,
    message: `Ready?`
  });

  // If Striker is a Bot, auto-reply Ready in 600ms
  if (isSlotBot(room, g.strikerSlot)) {
    setTimeout(() => {
      handleBatterReadyResponse(roomCode, g.strikerSlot, true);
    }, 600);
  }
}

function handleBatterReadyResponse(roomCode, senderSlot, isReady) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'BOWLING_PREP' || senderSlot !== g.strikerSlot) return;

  g.isBatterReady = !!isReady;
  g.waitingForBatterReady = !g.isBatterReady;

  cricketRoomManager.gameEvent(roomCode, 'BATTER_READY_STATUS', {
    strikerSlot: g.strikerSlot,
    isBatterReady: g.isBatterReady,
    message: g.isBatterReady ? `Ready! Play!` : `Wait!`
  });

  if (g.isBatterReady && isSlotBot(room, g.currentBowlerSlot)) {
    scheduleBotRunupAndBowl(roomCode);
  }
}

function scheduleBotRunupAndBowl(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  clearTimeout(g.botActionTimer);
  g.botActionTimer = setTimeout(() => {
    if (g.phase !== 'BOWLING_PREP') return;
    const lines = ['off', 'middle', 'leg'];
    const lengths = ['yorker', 'good', 'bouncer'];
    const chosenLine = lines[Math.floor(Math.random() * lines.length)];
    const chosenLength = lengths[Math.floor(Math.random() * lengths.length)];

    // 1. Broadcast Bot's Run-up so Batter & Audience hear the footsteps from chosenLine!
    handleStartRunup(roomCode, g.currentBowlerSlot, chosenLine);

    // 2. Deliver ball at 1500ms (4th jump beep)
    g.botActionTimer = setTimeout(() => {
      if (g.phase !== 'BOWLING_PREP') return;
      handleBowlAction(roomCode, g.currentBowlerSlot, {
        line: chosenLine,
        length: chosenLength,
        speedFactor: 0.75 + Math.random() * 0.25,
        releaseAccuracy: 0.85
      });
    }, 1500);
  }, 1000);
}

// Broadcast 3D Run-up Footsteps to Batter, Fielders & Audience!
function handleStartRunup(roomCode, senderSlot, line) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'BOWLING_PREP' || senderSlot !== g.currentBowlerSlot) return;

  const chosenLine = line || 'middle';
  let audioPan = 0.0;
  if (chosenLine === 'off') audioPan = -0.55;
  else if (chosenLine === 'leg') audioPan = 0.55;

  cricketRoomManager.gameEvent(roomCode, 'BOWLER_RUNUP_AUDIO', {
    bowlerSlot: g.currentBowlerSlot,
    strikerSlot: g.strikerSlot,
    line: chosenLine,
    audioPan,
    idealReleaseMs: 1500
  });
}

function handleBowlAction(roomCode, senderSlot, payload) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'BOWLING_PREP' || senderSlot !== g.currentBowlerSlot) return;
  clearTimeout(g.botActionTimer);

  g.phase = 'BALL_IN_PLAY';

  const line = payload.line || 'middle';
  const length = payload.length || 'good';
  const speedFactor = Math.min(1.0, Math.max(0.4, Number(payload.speedFactor) || 0.8));
  const releaseAccuracy = Number(payload.releaseAccuracy) || 0.85;

  const isNoBall = releaseAccuracy < 0.25;
  const isWide = (line === 'wide_off' || line === 'wide_leg') || (releaseAccuracy < 0.40 && Math.random() < 0.4);

  let audioPan = 0.0;
  if (line === 'off') audioPan = -0.55;
  else if (line === 'leg') audioPan = 0.55;
  else if (line === 'wide_off') audioPan = -0.95;
  else if (line === 'wide_leg') audioPan = 0.95;

  let dropPitch = 0.80;
  let risePitch = 1.0;
  let bounceTimeRatio = 0.55;

  if (length === 'yorker') {
    dropPitch = 0.70;
    risePitch = 0.75;
    bounceTimeRatio = 0.85;
  } else if (length === 'bouncer' || length === 'short') {
    dropPitch = 0.85;
    risePitch = 1.35;
    bounceTimeRatio = 0.40;
  } else {
    dropPitch = 0.80;
    risePitch = 1.05;
    bounceTimeRatio = 0.60;
  }

  const baseFlightMs = g.currentBowlerStyle === 'fast' ? 1200 : 1600;
  const flightDurationMs = Math.round(baseFlightMs / speedFactor);

  g.currentDelivery = {
    line,
    length,
    speedFactor,
    audioPan,
    dropPitch,
    risePitch,
    bounceTimeRatio,
    flightDurationMs,
    isNoBall,
    isWide,
    bowledTimestamp: Date.now(),
    shotPlayed: false
  };

  cricketRoomManager.gameEvent(roomCode, 'BALL_BOWLED_AUDIO', {
    bowlerSlot: g.currentBowlerSlot,
    strikerSlot: g.strikerSlot,
    bowlerStyle: g.currentBowlerStyle,
    line,
    length,
    audioPan,
    dropPitch,
    risePitch,
    bounceTimeRatio,
    flightDurationMs,
    soundCue: g.currentBowlerStyle === 'fast' ? 'runup_fast_beep_ball' : 'runup_spin_beep_ball'
  });

  if (isSlotBot(room, g.strikerSlot)) {
    setTimeout(() => {
      if (g.phase === 'BALL_IN_PLAY' && g.currentDelivery && !g.currentDelivery.shotPlayed) {
        const directions = ['off', 'straight', 'leg', 'defense'];
        handleBatAction(roomCode, g.strikerSlot, {
          direction: directions[Math.floor(Math.random() * directions.length)],
          timingScore: 0.65 + Math.random() * 0.35,
          power: 0.5 + Math.random() * 0.5
        });
      }
    }, flightDurationMs);
  } else {
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      if (g.phase === 'BALL_IN_PLAY' && g.currentDelivery && !g.currentDelivery.shotPlayed) {
        handleBatAction(roomCode, g.strikerSlot, {
          direction: 'leave',
          timingScore: 0.0,
          power: 0.0
        });
      }
    }, flightDurationMs + 1000);
  }
}

// ============================================================
// BATTING ACTION & TRAJECTORY / FIELDING TRIGGER
// ============================================================
function handleBatAction(roomCode, senderSlot, payload) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'BALL_IN_PLAY' || senderSlot !== g.strikerSlot || !g.currentDelivery || g.currentDelivery.shotPlayed) return;
  clearTimeout(g.botActionTimer);
  g.currentDelivery.shotPlayed = true;

  const deliv = g.currentDelivery;
  const shotDir = payload.direction || 'straight';
  const timingScore = Math.min(1.0, Math.max(0.0, Number(payload.timingScore) || 0.5));
  const shotPower = Math.min(1.0, Math.max(0.2, Number(payload.power) || 0.7));

  if (shotDir === 'leave') {
    if (deliv.isWide) {
      return completeBallResolution(roomCode, {
        runs: 1, isExtra: true, extraType: 'WD',
        soundCue: 'keeper_gloves_collect',
        crowdCue: 'crowd_ambient_low',
        commentary: `Wide ball.`
      });
    }
    if (deliv.line === 'middle' && deliv.length !== 'bouncer') {
      if (Math.random() < 0.55 && !deliv.isNoBall) {
        return triggerUmpireDismissalCheck(roomCode, {
          type: 'BOWLED',
          isActuallyOut: true,
          ultraEdgeSpike: false,
          pitching: 'IN_LINE',
          impact: 'IN_LINE',
          wicketsHitting: 'HITTING',
          soundCue: 'bowled_timber_crash',
          commentary: `Bowled!`
        });
      } else {
        return triggerUmpireDismissalCheck(roomCode, {
          type: 'LBW',
          isActuallyOut: deliv.length === 'good' || deliv.length === 'full',
          ultraEdgeSpike: false,
          pitching: 'IN_LINE',
          impact: 'IN_LINE',
          wicketsHitting: (deliv.length === 'good' || deliv.length === 'full') ? 'HITTING' : 'MISSING',
          soundCue: 'pad_thud_appeal',
          commentary: `LBW appeal!`
        });
      }
    }
    return completeBallResolution(roomCode, {
      runs: 0, isExtra: false,
      soundCue: 'keeper_gloves_collect',
      crowdCue: 'crowd_ambient_low',
      commentary: `Left. Dot ball.`
    });
  }

  if (timingScore < 0.25) {
    if (deliv.isWide) {
      return completeBallResolution(roomCode, {
        runs: 1, isExtra: true, extraType: 'WD',
        soundCue: 'keeper_gloves_collect',
        crowdCue: 'crowd_ambient_low',
        commentary: `Wide.`
      });
    }
    if (deliv.line === 'middle' && deliv.length !== 'bouncer' && !deliv.isNoBall) {
      const isBowled = Math.random() < 0.6;
      if (isBowled) {
        return triggerUmpireDismissalCheck(roomCode, {
          type: 'BOWLED',
          isActuallyOut: true,
          ultraEdgeSpike: false,
          pitching: 'IN_LINE',
          impact: 'IN_LINE',
          wicketsHitting: 'HITTING',
          soundCue: 'bowled_timber_crash',
          commentary: `Clean Bowled!`
        });
      } else {
        const hitting = Math.random() < 0.65 ? 'HITTING' : (Math.random() < 0.5 ? 'UMPIRES_CALL' : 'MISSING');
        return triggerUmpireDismissalCheck(roomCode, {
          type: 'LBW',
          isActuallyOut: hitting !== 'MISSING',
          ultraEdgeSpike: false,
          pitching: 'IN_LINE',
          impact: 'IN_LINE',
          wicketsHitting: hitting,
          soundCue: 'pad_thud_appeal',
          commentary: `LBW shout!`
        });
      }
    }
    return completeBallResolution(roomCode, {
      runs: 0, isExtra: false,
      soundCue: 'swing_and_miss_keeper',
      crowdCue: 'crowd_ooh_close',
      commentary: `Missed. Dot.`
    });
  }

  if (timingScore >= 0.88 && shotDir !== 'defense') {
    if (shotPower >= 0.80 && Math.random() < 0.55) {
      return completeBallResolution(roomCode, {
        runs: 6, isExtra: deliv.isNoBall, extraType: deliv.isNoBall ? 'NB' : null,
        soundCue: 'bat_sweet_spot_six',
        crowdCue: 'crowd_roar_six',
        commentary: `Six runs!`
      });
    } else {
      return completeBallResolution(roomCode, {
        runs: 4, isExtra: deliv.isNoBall, extraType: deliv.isNoBall ? 'NB' : null,
        soundCue: 'bat_sweet_spot_four',
        crowdCue: 'crowd_cheer_four',
        commentary: `Four runs!`
      });
    }
  }

  if (timingScore >= 0.25 && timingScore < 0.38 && Math.random() < 0.5 && !deliv.isNoBall) {
    const hasRealEdge = Math.random() < 0.7;
    return triggerUmpireDismissalCheck(roomCode, {
      type: 'CAUGHT_BEHIND',
      isActuallyOut: hasRealEdge,
      ultraEdgeSpike: hasRealEdge,
      pitching: 'OUTSIDE_OFF',
      impact: 'OUTSIDE_OFF',
      wicketsHitting: 'MISSING',
      soundCue: hasRealEdge ? 'bat_faint_edge_keeper' : 'swing_and_miss_keeper',
      commentary: `Caught behind appeal!`
    });
  }

  initiateFieldingPhase(roomCode, shotDir, timingScore, shotPower);
}

// ============================================================
// 3D FIELDING, CATCH / DIVE & STUMP THROW SKILL MECHANICS
// ============================================================
function initiateFieldingPhase(roomCode, shotDir, timingScore, shotPower) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  g.phase = 'FIELDING_ACTION';

  const isAirBall = (timingScore < 0.58 && shotDir !== 'defense' && shotPower > 0.55);
  const needsDive = Math.random() < 0.42;
  const diveDirection = needsDive ? (Math.random() < 0.5 ? 'left' : 'right') : 'center';
  const fielderAudioPan = diveDirection === 'left' ? -0.82 : (diveDirection === 'right' ? 0.82 : 0.0);

  const bowlSlots = getTeamSlots(room, g.bowlingTeam);
  const activeFielderSlot = pickFielderForShot(bowlSlots, g.currentBowlerSlot, shotDir);
  const fielderPosKey = g.fieldingMap[activeFielderSlot] || 'mid_off';
  const fielderPosName = FIELDING_POSITIONS[fielderPosKey]?.name || 'Mid Off';

  const batContactSound = timingScore >= 0.65 ? 'bat_good_contact' : 'bat_mistimed_hit';
  const ballTravelSound = isAirBall ? 'beep_ball_air_high_pitch' : 'beep_ball_ground_roll';

  g.currentDelivery.fieldingState = {
    activeFielderSlot,
    fielderName: getPlayerNameBySlot(room, activeFielderSlot),
    fielderPosName,
    isAirBall,
    needsDive,
    diveDirection,
    fielderAudioPan,
    ballPitch: isAirBall ? 1.30 : 0.90,
    timingScore,
    resolved: false,
    ballStopped: false
  };

  cricketRoomManager.gameEvent(roomCode, 'FIELDING_CHANCE', {
    activeFielderSlot,
    fielderName: getPlayerNameBySlot(room, activeFielderSlot),
    fielderPosName,
    isAirBall,
    needsDive,
    diveDirection,
    fielderAudioPan,
    ballPitch: isAirBall ? 1.30 : 0.90,
    batContactSound,
    ballTravelSound,
    message: isAirBall
      ? `Catch at ${fielderPosName}!`
      : `Ball to ${fielderPosName}!`
  });

  if (isSlotBot(room, activeFielderSlot)) {
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      const botSuccess = Math.random() < 0.72;
      handleFieldingAction(roomCode, activeFielderSlot, {
        actionType: botSuccess ? (needsDive ? `dive_${diveDirection}` : 'catch_or_stop') : 'missed',
        reactionScore: botSuccess ? 0.85 : 0.2,
        throwEnd: Math.random() < 0.6 ? 'batting' : 'bowling',
        throwStraightness: 0.70 + Math.random() * 0.30
      });
    }, 1200);
  } else {
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      if (g.phase === 'FIELDING_ACTION' && g.currentDelivery?.fieldingState && !g.currentDelivery.fieldingState.resolved) {
        handleFieldingAction(roomCode, activeFielderSlot, {
          actionType: 'missed',
          reactionScore: 0.0
        });
      }
    }, 2800);
  }
}

function pickFielderForShot(bowlSlots, bowlerSlot, shotDir) {
  if (bowlSlots.length <= 1) return bowlSlots[0] ?? 0;
  const nonBowlers = bowlSlots.filter(s => s !== bowlerSlot);
  if (nonBowlers.length === 0) return bowlerSlot;
  return nonBowlers[Math.floor(Math.random() * nonBowlers.length)];
}

function handleFieldingAction(roomCode, senderSlot, payload) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const fs = g.currentDelivery?.fieldingState;
  if (g.phase !== 'FIELDING_ACTION' || !fs || fs.resolved || senderSlot !== fs.activeFielderSlot) return;
  clearTimeout(g.botActionTimer);
  fs.resolved = true;

  const actionType = payload.actionType || 'catch_or_stop';
  const reactionScore = Number(payload.reactionScore) || 0.75;
  const throwEnd = payload.throwEnd || 'batting';
  const throwStraightness = Math.min(1.0, Math.max(0.0, Number(payload.throwStraightness) || 0.75));

  const correctGesture = fs.needsDive
    ? (actionType === `dive_${fs.diveDirection}`)
    : (actionType === 'catch_or_stop');

  const isFieldedCleanly = correctGesture && reactionScore >= 0.50;

  if (fs.isAirBall && isFieldedCleanly && !g.currentDelivery.isNoBall) {
    return completeBallResolution(roomCode, {
      runs: 0,
      isWicket: true,
      wicketType: 'CAUGHT',
      fielderName: fs.fielderName,
      soundCue: fs.needsDive ? 'diving_catch_roar' : 'clean_catch_roar',
      crowdCue: 'crowd_wicket_celebration',
      commentary: `Caught by ${fs.fielderName}!`
    });
  }

  if (!isFieldedCleanly) {
    const boundaryFour = fs.timingScore >= 0.70 && Math.random() < 0.65;
    const runsScored = boundaryFour ? 4 : 2;
    return completeBallResolution(roomCode, {
      runs: runsScored,
      isExtra: g.currentDelivery.isNoBall,
      extraType: g.currentDelivery.isNoBall ? 'NB' : null,
      soundCue: boundaryFour ? 'misfield_boundary_four' : 'batsman_running_two',
      crowdCue: boundaryFour ? 'crowd_cheer_four' : 'crowd_ambient_low',
      commentary: boundaryFour ? `Misfield, Four!` : `Two runs.`
    });
  }

  if (throwStraightness >= 0.88 && reactionScore >= 0.75) {
    const batterShortOfCrease = Math.random() < 0.45;
    if (batterShortOfCrease) {
      return triggerUmpireDismissalCheck(roomCode, {
        type: 'RUN_OUT',
        isActuallyOut: true,
        ultraEdgeSpike: false,
        pitching: 'N/A',
        impact: 'N/A',
        wicketsHitting: 'DIRECT_HIT_SHORT',
        soundCue: 'direct_hit_stump_shatter',
        commentary: `Direct hit!`
      });
    } else {
      return completeBallResolution(roomCode, {
        runs: 0,
        soundCue: 'direct_hit_stump_safe',
        crowdCue: 'crowd_ooh_close',
        commentary: `Direct hit, safe. Dot.`
      });
    }
  } else if (throwStraightness < 0.45) {
    return completeBallResolution(roomCode, {
      runs: 2,
      soundCue: 'throw_missed_stumps_overthrow',
      crowdCue: 'crowd_ooh_close',
      commentary: `Overthrow, 2 runs!`
    });
  } else {
    const singleTaken = Math.random() < 0.55;
    return completeBallResolution(roomCode, {
      runs: singleTaken ? 1 : 0,
      soundCue: 'throw_collected_gloves',
      crowdCue: 'crowd_ambient_low',
      commentary: singleTaken ? `One run.` : `Fielded. No run.`
    });
  }
}

// ============================================================
// INTERNATIONAL UMPIRE & DRS REVIEW SYSTEM
// ============================================================
function triggerUmpireDismissalCheck(roomCode, appealData) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  g.phase = 'DRS_PENDING';

  const isCloseCall = (appealData.type === 'LBW' || appealData.type === 'CAUGHT_BEHIND');
  const umpireMadeError = isCloseCall && (Math.random() < 0.18);
  const onFieldDecision = umpireMadeError ? !appealData.isActuallyOut : appealData.isActuallyOut;

  const canBattingTeamReview = onFieldDecision === true && g.reviewsLeft[g.battingTeam] > 0;
  const canBowlingTeamReview = onFieldDecision === false && g.reviewsLeft[g.bowlingTeam] > 0;

  g.pendingDismissal = {
    ...appealData,
    onFieldDecision,
    reviewEligibleTeam: onFieldDecision ? g.battingTeam : g.bowlingTeam,
    resolved: false
  };

  cricketRoomManager.gameEvent(roomCode, 'UMPIRE_DECISION_PROMPT_DRS', {
    appealType: appealData.type,
    onFieldDecision: onFieldDecision ? 'OUT' : 'NOT_OUT',
    strikerSlot: g.strikerSlot,
    strikerName: getPlayerNameBySlot(room, g.strikerSlot),
    bowlingCaptainSlot: getCaptainSlot(room, g.bowlingTeam),
    battingCaptainSlot: getCaptainSlot(room, g.battingTeam),
    canBattingTeamReview,
    canBowlingTeamReview,
    reviewsLeft: g.reviewsLeft,
    soundCue: appealData.soundCue,
    crowdCue: onFieldDecision ? 'crowd_wicket_celebration' : 'crowd_ooh_close',
    message: `${appealData.commentary} Umpire gives ${onFieldDecision ? 'OUT!' : 'NOT OUT!'}`
  });

  clearTimeout(g.drsTimer);
  g.drsTimer = setTimeout(() => {
    if (g.phase === 'DRS_PENDING' && g.pendingDismissal && !g.pendingDismissal.resolved) {
      finalizeDismissalAfterDrs(roomCode, false);
    }
  }, 8000);
}

function handleDrsRequest(roomCode, senderSlot) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'DRS_PENDING' || !g.pendingDismissal || g.pendingDismissal.resolved) return;

  const pd = g.pendingDismissal;
  const reviewingTeam = pd.reviewEligibleTeam;
  const allowedReviewerSlots = [
    getCaptainSlot(room, reviewingTeam),
    g.strikerSlot
  ];

  if (!allowedReviewerSlots.includes(senderSlot) && g.playMode !== 'individual') return;
  if (g.reviewsLeft[reviewingTeam] <= 0) return;

  clearTimeout(g.drsTimer);
  pd.resolved = true;

  const finalDecisionOut = pd.isActuallyOut;
  const decisionOverturned = (finalDecisionOut !== pd.onFieldDecision);
  const isUmpiresCall = (pd.wicketsHitting === 'UMPIRES_CALL');

  if (!decisionOverturned && !isUmpiresCall) {
    g.reviewsLeft[reviewingTeam] = Math.max(0, g.reviewsLeft[reviewingTeam] - 1);
  }

  cricketRoomManager.gameEvent(roomCode, 'DRS_THIRD_UMPIRE_AUDIO', {
    reviewingTeam,
    appealType: pd.type,
    onFieldDecision: pd.onFieldDecision ? 'OUT' : 'NOT_OUT',
    ultraEdgeSpike: pd.ultraEdgeSpike,
    pitching: pd.pitching,
    impact: pd.impact,
    wicketsHitting: pd.wicketsHitting,
    finalDecision: finalDecisionOut ? 'OUT' : 'NOT_OUT',
    decisionOverturned,
    isUmpiresCall,
    reviewsLeft: g.reviewsLeft,
    soundCue: 'drs_tv_umpire_stinger',
    crowdCue: finalDecisionOut ? 'crowd_wicket_celebration' : 'crowd_roar_six',
    message: buildThirdUmpireTranscript(pd, finalDecisionOut)
  });

  setTimeout(() => {
    pd.onFieldDecision = finalDecisionOut;
    finalizeDismissalAfterDrs(roomCode, true);
  }, 2500);
}

function buildThirdUmpireTranscript(pd, finalOut) {
  if (pd.type === 'CAUGHT_BEHIND') {
    return pd.ultraEdgeSpike ? `Spike on UltraEdge! OUT!` : `Flat line. NOT OUT!`;
  } else if (pd.type === 'LBW') {
    return `Impact ${pd.impact}, Wickets ${pd.wicketsHitting}. ${finalOut ? 'OUT!' : 'NOT OUT!'}`;
  }
  return `Replay confirms ${finalOut ? 'OUT!' : 'NOT OUT!'}`;
}

function finalizeDismissalAfterDrs(roomCode, wasReviewed) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const pd = g.pendingDismissal;
  if (!pd) return;
  pd.resolved = true;

  if (pd.onFieldDecision) {
    completeBallResolution(roomCode, {
      runs: 0,
      isWicket: true,
      wicketType: pd.type,
      soundCue: 'umpire_out_finger',
      crowdCue: 'crowd_wicket_celebration',
      commentary: `OUT! ${pd.type}!`
    });
  } else {
    completeBallResolution(roomCode, {
      runs: 0,
      isWicket: false,
      soundCue: 'umpire_not_out',
      crowdCue: 'crowd_ambient_low',
      commentary: `Not Out.`
    });
  }
}

// ============================================================
// COMPLETE BALL RESOLUTION & OVER / BATSMAN ROTATION
// ============================================================
function completeBallResolution(roomCode, res) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const runs = res.runs || 0;
  const isExtra = !!res.isExtra;
  const isWicket = !!res.isWicket;

  const strikerStats = g.batsmanStats[g.strikerSlot];
  const bowlerStats = g.bowlerStats[g.currentBowlerSlot];

  g.score += runs;
  g.runsInCurrentOver += runs;
  if (bowlerStats) bowlerStats.runsConceded += runs;

  if (!isExtra) {
    g.ballsBowledInInnings++;
    g.ballsInCurrentOver++;
    if (strikerStats) {
      strikerStats.balls++;
      strikerStats.runs += runs;
      if (runs === 4) strikerStats.fours++;
      if (runs === 6) strikerStats.sixes++;
    }
    if (bowlerStats) bowlerStats.balls++;
  }

  if (isWicket) {
    g.wickets++;
    if (strikerStats) {
      strikerStats.status = 'out';
      strikerStats.outDesc = res.wicketType || 'OUT';
    }
    if (bowlerStats && res.wicketType !== 'RUN_OUT') {
      bowlerStats.wickets++;
    }
  }

  if ((runs % 2 === 1) && g.nonStrikerSlot !== -1) {
    const tmp = g.strikerSlot;
    g.strikerSlot = g.nonStrikerSlot;
    g.nonStrikerSlot = tmp;
  }

  cricketRoomManager.gameEvent(roomCode, 'BALL_OUTCOME', {
    runs,
    isExtra,
    extraType: res.extraType || null,
    isWicket,
    wicketType: res.wicketType || null,
    score: g.score,
    wickets: g.wickets,
    oversFormatted: `${Math.floor(g.ballsBowledInInnings / 6)}.${g.ballsBowledInInnings % 6}`,
    strikerSlot: g.strikerSlot,
    strikerName: getPlayerNameBySlot(room, g.strikerSlot),
    nonStrikerSlot: g.nonStrikerSlot,
    nonStrikerName: g.nonStrikerSlot !== -1 ? getPlayerNameBySlot(room, g.nonStrikerSlot) : 'Runner',
    bowlerSlot: g.currentBowlerSlot,
    bowlerName: getPlayerNameBySlot(room, g.currentBowlerSlot),
    batsmanStats: g.batsmanStats,
    bowlerStats: g.bowlerStats,
    soundCue: res.soundCue || 'ball_dot',
    crowdCue: res.crowdCue || 'crowd_ambient_low',
    commentary: res.commentary
  });

  if (checkInningsOrMatchEnd(roomCode)) return;

  if (isWicket) {
    const availableBatters = getAvailableBatters(room, g);
    if (availableBatters.length > 0) {
      setTimeout(() => promptCaptainForNextBatsman(roomCode, availableBatters), 1400);
      return;
    }
  }

  if (g.ballsInCurrentOver >= 6) {
    handleEndOfOver(roomCode);
  } else {
    setTimeout(() => startNextBallPrep(roomCode), 1400);
  }
}

function handleEndOfOver(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const bowlerStats = g.bowlerStats[g.currentBowlerSlot];
  if (bowlerStats) {
    bowlerStats.oversCompleted++;
    if (g.runsInCurrentOver === 0) bowlerStats.maidens++;
  }

  if (g.currentBowlerStyle === 'fast') g.paceOversBowled++;
  else g.spinOversBowled++;

  g.ballsInCurrentOver = 0;
  g.runsInCurrentOver = 0;
  g.lastOverBowlerSlot = g.currentBowlerSlot;

  if (g.nonStrikerSlot !== -1) {
    const tmp = g.strikerSlot;
    g.strikerSlot = g.nonStrikerSlot;
    g.nonStrikerSlot = tmp;
  }

  if (checkInningsOrMatchEnd(roomCode)) return;

  setTimeout(() => promptCaptainForNextBowler(roomCode, false), 1400);
}

// ============================================================
// CAPTAIN LIVE CONTROLS (RETIRE BATSMAN, NEXT BATSMAN, FIELDING ZONES)
// ============================================================
function getAvailableBatters(room, g) {
  const batSlots = getTeamSlots(room, g.battingTeam);
  return batSlots.filter(s => g.batsmanStats[s]?.status === 'yet_to_bat');
}

function promptCaptainForNextBatsman(roomCode, availableSlots) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  g.phase = 'SELECT_BATSMAN';
  const batCaptainSlot = getCaptainSlot(room, g.battingTeam);

  const battersList = availableSlots.map(s => ({
    slot: s,
    name: getPlayerNameBySlot(room, s)
  }));

  cricketRoomManager.gameEvent(roomCode, 'SELECT_NEXT_BATSMAN_PROMPT', {
    battingTeam: g.battingTeam,
    captainSlot: batCaptainSlot,
    battersList,
    message: `Select next batter.`
  });

  if (isSlotBot(room, batCaptainSlot) || battersList.length === 1) {
    setTimeout(() => applyNextBatsmanSelection(roomCode, battersList[0].slot), 1200);
  }
}

function applyNextBatsmanSelection(roomCode, newBatterSlot) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const slot = Number(newBatterSlot);
  if (!g.batsmanStats[slot] || g.batsmanStats[slot].status !== 'yet_to_bat') return;

  g.strikerSlot = slot;
  g.batsmanStats[slot].status = 'batting';

  cricketRoomManager.gameEvent(roomCode, 'NEW_BATSMAN_IN', {
    strikerSlot: slot,
    strikerName: getPlayerNameBySlot(room, slot),
    soundCue: 'crowd_applause_new_batter',
    message: `${getPlayerNameBySlot(room, slot)} in.`
  });

  if (g.ballsInCurrentOver >= 6) {
    handleEndOfOver(roomCode);
  } else {
    setTimeout(() => startNextBallPrep(roomCode), 1000);
  }
}

function handleRetireBatsman(roomCode, captainSlot, targetBatterSlot, replacementSlot) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (captainSlot !== getCaptainSlot(room, g.battingTeam)) return;
  const avail = getAvailableBatters(room, g);
  if (avail.length === 0) return;

  const repSlot = (replacementSlot !== undefined && avail.includes(Number(replacementSlot)))
    ? Number(replacementSlot)
    : avail[0];

  const oldName = getPlayerNameBySlot(room, targetBatterSlot);
  const newName = getPlayerNameBySlot(room, repSlot);

  if (g.batsmanStats[targetBatterSlot]) {
    g.batsmanStats[targetBatterSlot].status = 'retired';
    g.batsmanStats[targetBatterSlot].outDesc = 'Retired';
  }
  g.batsmanStats[repSlot].status = 'batting';

  if (g.strikerSlot === targetBatterSlot) g.strikerSlot = repSlot;
  else if (g.nonStrikerSlot === targetBatterSlot) g.nonStrikerSlot = repSlot;

  cricketRoomManager.gameEvent(roomCode, 'BATSMAN_RETIRED_SWAP', {
    retiredSlot: targetBatterSlot,
    retiredName: oldName,
    newBatterSlot: repSlot,
    newBatterName: newName,
    strikerSlot: g.strikerSlot,
    nonStrikerSlot: g.nonStrikerSlot,
    message: `${oldName} retired. ${newName} in.`
  });
}

function handleFieldingPositionUpdate(roomCode, captainSlot, fielderSlot, newPositionKey) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (captainSlot !== getCaptainSlot(room, g.bowlingTeam)) return;
  if (!FIELDING_POSITIONS[newPositionKey]) return;

  g.fieldingMap[Number(fielderSlot)] = newPositionKey;
  const fName = getPlayerNameBySlot(room, Number(fielderSlot));
  const posName = FIELDING_POSITIONS[newPositionKey].name;

  cricketRoomManager.gameEvent(roomCode, 'FIELDING_POSITION_UPDATED', {
    fielderSlot: Number(fielderSlot),
    fielderName: fName,
    positionKey: newPositionKey,
    positionName: posName,
    audioPan: FIELDING_POSITIONS[newPositionKey].pan,
    fieldingMap: g.fieldingMap,
    message: `${fName} to ${posName}.`
  });
}

// ============================================================
// INNINGS BREAK & MATCH OVER CHECK
// ============================================================
function checkInningsOrMatchEnd(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return false;
  const g = room.game;

  const totalBallsAllowed = g.totalOvers * 6;
  const allOut = g.wickets >= g.maxWickets;
  const oversFinished = g.ballsBowledInInnings >= totalBallsAllowed;
  const targetChased = (g.innings === 2 && g.target !== null && g.score >= g.target);

  if (!allOut && !oversFinished && !targetChased) return false;

  if (g.innings === 1) {
    g.phase = 'INNINGS_BREAK';
    g.target = g.score + 1;
    g.firstInningsSummary = {
      battingTeam: g.battingTeam,
      score: g.score,
      wickets: g.wickets,
      balls: g.ballsBowledInInnings
    };

    const firstBatName = g.battingTeam === 'A' ? room.teamAName : room.teamBName;
    const secondBatName = g.bowlingTeam === 'A' ? room.teamAName : room.teamBName;

    cricketRoomManager.gameEvent(roomCode, 'INNINGS_BREAK', {
      firstBattingTeamName: firstBatName,
      secondBattingTeamName: secondBatName,
      score: g.score,
      wickets: g.wickets,
      target: g.target,
      totalOvers: g.totalOvers,
      soundCue: 'innings_break_applause',
      message: `Innings break. Target ${g.target}.`
    });

    setTimeout(() => {
      if (!cricketRoomManager.cricketRooms.has(roomCode)) return;
      g.innings = 2;
      const oldBat = g.battingTeam;
      g.battingTeam = g.bowlingTeam;
      g.bowlingTeam = oldBat;
      g.score = 0;
      g.wickets = 0;
      g.ballsBowledInInnings = 0;
      g.ballsInCurrentOver = 0;
      g.runsInCurrentOver = 0;

      setupDefaultInningsRoles(room, g);

      const bowlSlots = getTeamSlots(room, g.bowlingTeam);
      if (bowlSlots.length > 1) {
        promptCaptainForNextBowler(roomCode, true);
      } else {
        startNextBallPrep(roomCode);
      }
    }, 3500);

    return true;
  }

  g.phase = 'MATCH_OVER';
  let winningTeam = null;
  let resultText = '';

  const batTeamName = g.battingTeam === 'A' ? room.teamAName : room.teamBName;
  const bowlTeamName = g.bowlingTeam === 'A' ? room.teamAName : room.teamBName;

  if (g.score >= g.target) {
    winningTeam = g.battingTeam;
    const wktsLeft = Math.max(1, g.maxWickets - g.wickets);
    resultText = `${batTeamName} won by ${wktsLeft} wickets!`;
  } else if (g.score === g.target - 1) {
    winningTeam = 'TIE';
    resultText = `Match Tied!`;
  } else {
    winningTeam = g.bowlingTeam;
    const runMargin = (g.target - 1) - g.score;
    resultText = `${bowlTeamName} won by ${runMargin} runs!`;
  }

  cricketRoomManager.gameEvent(roomCode, 'MATCH_OVER', {
    winningTeam,
    resultText,
    secondInningsScore: g.score,
    secondInningsWickets: g.wickets,
    firstInningsSummary: g.firstInningsSummary,
    batsmanStats: g.batsmanStats,
    bowlerStats: g.bowlerStats,
    soundCue: 'match_victory_fireworks',
    crowdCue: 'crowd_roar_six',
    message: resultText
  });

  if (winningTeam === 'A' || winningTeam === 'B') {
    cricketRoomManager.resolveCricketGame(roomCode, winningTeam);
  }

  return true;
}

// ============================================================
// WEBSOCKET ACTION ROUTER
// ============================================================
function handleGameAction(roomCode, playerId, msg) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  const playerEntry = room.players[playerId];
  const senderSlot = playerEntry ? playerEntry.slot : -1;

  switch (msg.type) {
    case 'PING':
      cricketRoomManager.gameEvent(roomCode, 'PONG', { ts: Date.now() }, playerId);
      break;

    case 'REQUEST_SYNC':
      cricketRoomManager.gameEvent(roomCode, 'SYNC_STATE', {
        phase: g.phase,
        tossWinnerTeam: g.tossWinnerTeam,
        tossWinnerCaptainSlot: g.tossWinnerTeam ? getCaptainSlot(room, g.tossWinnerTeam) : 0,
        innings: g.innings,
        score: g.score,
        wickets: g.wickets,
        totalOvers: g.totalOvers,
        ballsBowledInInnings: g.ballsBowledInInnings,
        target: g.target,
        battingTeam: g.battingTeam,
        bowlingTeam: g.bowlingTeam,
        strikerSlot: g.strikerSlot,
        strikerName: getPlayerNameBySlot(room, g.strikerSlot),
        nonStrikerSlot: g.nonStrikerSlot,
        nonStrikerName: g.nonStrikerSlot !== -1 ? getPlayerNameBySlot(room, g.nonStrikerSlot) : 'Runner',
        currentBowlerSlot: g.currentBowlerSlot,
        bowlerName: getPlayerNameBySlot(room, g.currentBowlerSlot),
        currentBowlerStyle: g.currentBowlerStyle,
        isBatterReady: g.isBatterReady,
        fieldingMap: g.fieldingMap,
        batsmanStats: g.batsmanStats,
        bowlerStats: g.bowlerStats,
        reviewsLeft: g.reviewsLeft,
        teamAName: room.teamAName,
        teamBName: room.teamBName
      }, playerId);
      break;

    case 'ACTION_TOSS_DECISION':
      if (senderSlot === getCaptainSlot(room, g.tossWinnerTeam) || senderSlot === 0) {
        handleTossDecision(roomCode, msg.choice === 'BOWL' ? 'BOWL' : 'BAT');
      }
      break;

    case 'ACTION_SELECT_BOWLER':
      if (senderSlot === getCaptainSlot(room, g.bowlingTeam)) {
        applyBowlerSelection(roomCode, msg.bowlerSlot, msg.style);
      }
      break;

    case 'ACTION_SELECT_BATSMAN':
      if (senderSlot === getCaptainSlot(room, g.battingTeam)) {
        applyNextBatsmanSelection(roomCode, msg.batterSlot);
      }
      break;

    case 'ACTION_RETIRE_BATSMAN':
      handleRetireBatsman(roomCode, senderSlot, Number(msg.targetBatterSlot), msg.replacementSlot);
      break;

    case 'ACTION_SET_FIELD_POSITION':
      handleFieldingPositionUpdate(roomCode, senderSlot, msg.fielderSlot, msg.positionKey);
      break;

    case 'ACTION_ASK_READY':
      handleAskReady(roomCode, senderSlot);
      break;

    case 'ACTION_BATTER_READY':
      handleBatterReadyResponse(roomCode, senderSlot, !!msg.ready);
      break;

    case 'ACTION_START_RUNUP':
      handleStartRunup(roomCode, senderSlot, msg.line);
      break;

    case 'ACTION_BOWL':
      handleBowlAction(roomCode, senderSlot, msg);
      break;

    case 'ACTION_BAT':
      handleBatAction(roomCode, senderSlot, msg);
      break;

    case 'ACTION_FIELD':
      handleFieldingAction(roomCode, senderSlot, msg);
      break;

    case 'ACTION_TAKE_DRS':
      handleDrsRequest(roomCode, senderSlot);
      break;
  }
}

function handlePlayerDisconnectDuringGame(roomCode, disconnectedSlot) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase === 'BOWLING_PREP' && g.currentBowlerSlot === disconnectedSlot) {
    startNextBallPrep(roomCode);
  } else if (g.phase === 'SELECT_BOWLER' && getCaptainSlot(room, g.bowlingTeam) === disconnectedSlot) {
    promptCaptainForNextBowler(roomCode, false);
  }
}

module.exports = {
  initGame,
  handleGameAction,
  handlePlayerDisconnectDuringGame,
  FIELDING_POSITIONS
};