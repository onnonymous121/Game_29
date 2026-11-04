/**
 * Server-Side Audio Cricket Game Engine (games/cricket.js)
 * ============================================================================
 * Features:
 * - Dynamic Overs (2, 5, 10, 20, etc.) & ICC Bowler Quota Rules (Max 20% overs per bowler)
 * - Fast vs Spin Bowler Type & Per-Bowler Live Figures (O-M-R-W)
 * - End-of-Over Captain Bowler Selection Prompt & Wicket/Retire Next-Batter Selection
 * - Live Captain Tactical Controls: Change Fielder Zones anytime, Retire Batsman
 * - Beep Ball 3D Audio Physics (Pan, Pitch, Drop, Air/Ground trajectory)
 * - Fielder Skill Mechanics (Catch/Stop timing, Swipe Straightness for Stump Direct Hit vs Miss)
 * - International Umpire & DRS Review System (2 Reviews per team, UltraEdge, Ball Tracking)
 * - Detailed Sound Cues for Frontend SoundManager (Crowd moods, Bat timing, Keeper, Timber)
 */

'use strict';

const cricketRoomManager = require('../cricketRoomManager');

// Standard Fielding Positions with Audio Angle (-1.0 Left/Off to +1.0 Right/Leg) & Depth
const FIELDING_POSITIONS = {
  'wicketkeeper': { name: 'Wicketkeeper', pan: 0.0, depth: 'close' },
  'slip':         { name: 'First Slip',   pan: -0.35, depth: 'close' },
  'gully':        { name: 'Gully',        pan: -0.65, depth: 'close' },
  'point':        { name: 'Point',        pan: -0.90, depth: 'inner' },
  'cover':        { name: 'Extra Cover',  pan: -0.60, depth: 'inner' },
  'mid_off':      { name: 'Mid Off',      pan: -0.25, depth: 'inner' },
  'mid_on':       { name: 'Mid On',       pan: 0.25,  depth: 'inner' },
  'mid_wicket':   { name: 'Mid Wicket',   pan: 0.65,  depth: 'inner' },
  'square_leg':   { name: 'Square Leg',   pan: 0.90,  depth: 'inner' },
  'fine_leg':     { name: 'Fine Leg',     pan: 0.45,  depth: 'boundary' },
  'third_man':    { name: 'Third Man',    pan: -0.45, depth: 'boundary' },
  'long_off':     { name: 'Long Off',     pan: -0.30, depth: 'boundary' },
  'long_on':      { name: 'Long On',      pan: 0.30,  depth: 'boundary' },
  'deep_cover':   { name: 'Deep Cover',   pan: -0.80, depth: 'boundary' },
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
  // International Rule: A bowler can bowl max 1/5th of total overs (e.g., 4 in 20 overs)
  // In Individual (1v1) mode, single player bowls all overs.
  const teamBSize = getTeamSlots(room, 'B').length;
  const teamASize = getTeamSlots(room, 'A').length;

  const g = {
    roomCode,
    playMode: room.playMode, // 'team' or 'individual'
    totalOvers,
    maxOversPerBowler: (room.playMode === 'individual') ? totalOvers : Math.max(1, Math.ceil(totalOvers / 5)),
    minSpinOvers: totalOvers >= 20 ? 6 : (totalOvers >= 10 ? 3 : 0),
    minPaceOvers: totalOvers >= 20 ? 6 : (totalOvers >= 10 ? 3 : 0),

    innings: 1, // 1 or 2
    phase: 'TOSS', // TOSS, SELECT_OPENERS, BOWLING_PREP, BALL_IN_PLAY, FIELDING_ACTION, UMPIRE_DECISION, DRS_PENDING, SELECT_BOWLER, SELECT_BATSMAN, INNINGS_BREAK, MATCH_OVER

    tossWinnerTeam: null, // 'A' or 'B'
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
    currentBowlerStyle: 'fast', // 'fast' or 'spin'

    // Per-Player Match Statistics & Status
    batsmanStats: {}, // slot -> { runs, balls, fours, sixes, status: 'yet_to_bat' | 'batting' | 'out' | 'retired' }
    bowlerStats: {},  // slot -> { balls, oversCompleted, maidens, runsConceded, wickets, style: 'fast' | 'spin' }
    fieldingMap: {},  // slot -> positionKey (e.g., 'slip', 'mid_off')

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

  // Start Toss automatically with audio cue
  cricketRoomManager.gameEvent(roomCode, 'MATCH_INIT', {
    teamAName: room.teamAName,
    teamBName: room.teamBName,
    overs: g.totalOvers,
    maxOversPerBowler: g.maxOversPerBowler,
    playMode: g.playMode,
    soundCue: 'stadium_welcome_roar'
  });

  setTimeout(() => performToss(roomCode), 2000);
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
  return entry ? entry.name : `Player ${slot + 1}`;
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

  // Max wickets: if 1 player, 1 wicket; if 2+ players, (N - 1) or all slots
  g.maxWickets = batSlots.length <= 1 ? 1 : batSlots.length;
  g.paceOversBowled = 0;
  g.spinOversBowled = 0;
  g.reviewsLeft = { A: 2, B: 2 };

  // Reset stats for the new innings
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

  // Assign Openers
  g.strikerSlot = batSlots[0];
  g.batsmanStats[g.strikerSlot].status = 'batting';

  if (batSlots.length > 1) {
    g.nonStrikerSlot = batSlots[1];
    g.batsmanStats[g.nonStrikerSlot].status = 'batting';
  } else {
    g.nonStrikerSlot = -1; // Solo batter mode
  }

  // Dynamic quota adjustment based on how many bowlers exist in bowling team
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
    message: `${winnerTeamName} won the toss! Captain is choosing to Bat or Bowl.`
  });

  if (isSlotBot(room, winnerCapSlot)) {
    setTimeout(() => handleTossDecision(roomCode, Math.random() < 0.5 ? 'BAT' : 'BOWL'), 2500);
  }
}

function handleTossDecision(roomCode, choice) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

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
    message: `${batTeamName} will bat first. ${getPlayerNameBySlot(room, g.strikerSlot)} is on strike.`
  });

  // Prompt Bowling Captain to confirm/choose 1st Over Bowler if multiple players exist
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
      style: st.style, // 'fast' or 'spin'
      figures: `${oversFormatted}-${st.maidens}-${st.runsConceded}-${st.wickets}`,
      oversBowled,
      oversRemainingQuota,
      isConsecutive,
      canBowl
    };
  });

  // Fallback if all bowlers hit quota due to unusual player count
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
      ? `Captain ${getPlayerNameBySlot(room, bowlCaptainSlot)}, select your opening bowler.`
      : `Over complete! Score is ${g.score} for ${g.wickets}. Captain, select bowler for Over ${Math.floor(g.ballsBowledInInnings / 6) + 1}.`
  });

  if (isSlotBot(room, bowlCaptainSlot)) {
    const eligible = bowlersList.filter(b => b.canBowl);
    const chosen = eligible.length > 0 ? eligible[Math.floor(Math.random() * eligible.length)] : bowlersList[0];
    setTimeout(() => applyBowlerSelection(roomCode, chosen.slot, chosen.style), 2200);
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
    message: `${bowlerName} (${g.currentBowlerStyle === 'fast' ? 'Fast Bowler' : 'Spin Bowler'}) will bowl this over.`
  });

  setTimeout(() => startNextBallPrep(roomCode), 1200);
}

// ============================================================
// BALL PREPARATION & BOWLING DELIVERY (3D BEEP BALL PHYSICS)
// ============================================================
function startNextBallPrep(roomCode) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (checkInningsOrMatchEnd(roomCode)) return;

  g.phase = 'BOWLING_PREP';
  g.currentDelivery = null;
  g.pendingDismissal = null;

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
    fieldingMap: g.fieldingMap,
    reviewsLeft: g.reviewsLeft,
    crowdMood: isCloseMatch ? 'crowd_tense_thriller' : 'crowd_ambient_low',
    message: `Ball ${overNum}.${ballNum}: ${getPlayerNameBySlot(room, g.currentBowlerSlot)} to ${getPlayerNameBySlot(room, g.strikerSlot)}.`
  });

  if (isSlotBot(room, g.currentBowlerSlot)) {
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      const lines = ['off', 'middle', 'leg'];
      const lengths = ['yorker', 'good', 'bouncer'];
      handleBowlAction(roomCode, g.currentBowlerSlot, {
        line: lines[Math.floor(Math.random() * lines.length)],
        length: lengths[Math.floor(Math.random() * lengths.length)],
        speedFactor: 0.75 + Math.random() * 0.25,
        releaseAccuracy: 0.85
      });
    }, 2800);
  }
}

function handleBowlAction(roomCode, senderSlot, payload) {
  const room = cricketRoomManager.cricketRooms.get(roomCode);
  if (!room || !room.game) return;
  const g = room.game;

  if (g.phase !== 'BOWLING_PREP' || senderSlot !== g.currentBowlerSlot) return;
  clearTimeout(g.botActionTimer);

  g.phase = 'BALL_IN_PLAY';

  // Line: 'off' (Pan -0.6), 'middle' (Pan 0.0), 'leg' (Pan +0.6), 'wide_off' (-0.95), 'wide_leg' (+0.95)
  const line = payload.line || 'middle';
  const length = payload.length || 'good'; // 'yorker', 'full', 'good', 'short', 'bouncer'
  const speedFactor = Math.min(1.0, Math.max(0.4, Number(payload.speedFactor) || 0.8));
  const releaseAccuracy = Number(payload.releaseAccuracy) || 0.85;

  // Check rare No-Ball (Overstepping if releaseAccuracy is very poor) or Wide
  const isNoBall = releaseAccuracy < 0.25;
  const isWide = (line === 'wide_off' || line === 'wide_leg') || (releaseAccuracy < 0.40 && Math.random() < 0.4);

  // Audio Panning (-1.0 Left/Off to +1.0 Right/Leg)
  let audioPan = 0.0;
  if (line === 'off') audioPan = -0.55;
  else if (line === 'leg') audioPan = 0.55;
  else if (line === 'wide_off') audioPan = -0.95;
  else if (line === 'wide_leg') audioPan = 0.95;

  // Pitch Modulation for Beep Ball (Bounce drop pitch -> Rise pitch)
  let dropPitch = 0.80;
  let risePitch = 1.0;
  let bounceTimeRatio = 0.55; // When ball hits turf during flight

  if (length === 'yorker') {
    dropPitch = 0.70;
    risePitch = 0.75; // Stays low
    bounceTimeRatio = 0.85;
  } else if (length === 'bouncer' || length === 'short') {
    dropPitch = 0.85;
    risePitch = 1.35; // Rises sharply towards head/chest
    bounceTimeRatio = 0.40;
  } else {
    dropPitch = 0.80;
    risePitch = 1.05;
    bounceTimeRatio = 0.60;
  }

  // Total flight duration in ms (Fast: ~1100ms, Spin: ~1550ms)
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

  // If Striker is a Bot, auto-play shot around ideal window
  if (isSlotBot(room, g.strikerSlot)) {
    setTimeout(() => {
      if (g.phase === 'BALL_IN_PLAY' && g.currentDelivery && !g.currentDelivery.shotPlayed) {
        const directions = ['off', 'straight', 'leg', 'defense'];
        handleBatAction(roomCode, g.strikerSlot, {
          direction: directions[Math.floor(Math.random() * directions.length)],
          timingScore: 0.65 + Math.random() * 0.35, // 0.0 to 1.0
          power: 0.5 + Math.random() * 0.5
        });
      }
    }, flightDurationMs);
  } else {
    // Wait for human batter; if they don't swing within window + 800ms, resolve as Leave / Missed ball
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      if (g.phase === 'BALL_IN_PLAY' && g.currentDelivery && !g.currentDelivery.shotPlayed) {
        handleBatAction(roomCode, g.strikerSlot, {
          direction: 'leave',
          timingScore: 0.0,
          power: 0.0
        });
      }
    }, flightDurationMs + 900);
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
  const shotDir = payload.direction || 'straight'; // 'left'/'off', 'right'/'leg', 'up'/'straight', 'down'/'defense', 'leave'
  const timingScore = Math.min(1.0, Math.max(0.0, Number(payload.timingScore) || 0.5));
  const shotPower = Math.min(1.0, Math.max(0.2, Number(payload.power) || 0.7));

  // 1. Check Wide / No-Ball if batter left the ball
  if (shotDir === 'leave') {
    if (deliv.isWide) {
      return completeBallResolution(roomCode, {
        runs: 1, isExtra: true, extraType: 'WD',
        soundCue: 'keeper_gloves_collect',
        crowdCue: 'crowd_ambient_low',
        commentary: `Wide ball! Collected by the wicketkeeper.`
      });
    }
    // Check if ball hits stumps or pads when left!
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
          commentary: `Clean Bowled! Left the ball on middle stump and the timber is shattered!`
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
          commentary: `Huge appeal for LBW after the batter offered no shot!`
        });
      }
    }
    return completeBallResolution(roomCode, {
      runs: 0, isExtra: false,
      soundCue: 'keeper_gloves_collect',
      crowdCue: 'crowd_ambient_low',
      commentary: `Left alone through to the wicketkeeper. No run.`
    });
  }

  // 2. Batter swung the bat: Evaluate Timing Quality
  // Sweet spot (0.82 - 1.0), Good contact (0.55 - 0.81), Mistimed/Edge (0.25 - 0.54), Complete miss (< 0.25)
  if (timingScore < 0.25) {
    // Batter missed the ball completely!
    if (deliv.isWide) {
      return completeBallResolution(roomCode, {
        runs: 1, isExtra: true, extraType: 'WD',
        soundCue: 'keeper_gloves_collect',
        crowdCue: 'crowd_ambient_low',
        commentary: `Wide delivery! Missed the swing.`
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
          commentary: `Bowled him! Swung and missed completely, the stumps are flying!`
        });
      } else {
        // Close LBW situation (Great for DRS!)
        const hitting = Math.random() < 0.65 ? 'HITTING' : (Math.random() < 0.5 ? 'UMPIRES_CALL' : 'MISSING');
        return triggerUmpireDismissalCheck(roomCode, {
          type: 'LBW',
          isActuallyOut: hitting !== 'MISSING',
          ultraEdgeSpike: false,
          pitching: 'IN_LINE',
          impact: 'IN_LINE',
          wicketsHitting: hitting,
          soundCue: 'pad_thud_appeal',
          commentary: `Rapped on the pads! Loud appeal for LBW from the bowler and keeper!`
        });
      }
    }
    return completeBallResolution(roomCode, {
      runs: 0, isExtra: false,
      soundCue: 'swing_and_miss_keeper',
      crowdCue: 'crowd_ooh_close',
      commentary: `Beaten! Whizzed past the outside edge into the keeper's gloves.`
    });
  }

  // 3. Sweet Spot Six or Clean Four
  if (timingScore >= 0.88 && shotDir !== 'defense') {
    if (shotPower >= 0.80 && Math.random() < 0.55) {
      return completeBallResolution(roomCode, {
        runs: 6, isExtra: deliv.isNoBall, extraType: deliv.isNoBall ? 'NB' : null,
        soundCue: 'bat_sweet_spot_six',
        crowdCue: 'crowd_roar_six',
        commentary: `Massive Six! Right off the sweet spot of the bat, sailing into the stands!`
      });
    } else {
      return completeBallResolution(roomCode, {
        runs: 4, isExtra: deliv.isNoBall, extraType: deliv.isNoBall ? 'NB' : null,
        soundCue: 'bat_sweet_spot_four',
        crowdCue: 'crowd_cheer_four',
        commentary: `Cracking Four! Pierced the gap at lightning speed to the boundary!`
      });
    }
  }

  // 4. Faint Edge to Wicketkeeper (Caught Behind candidate for DRS UltraEdge!)
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
      commentary: `Caught by the keeper! Big appeal for caught behind!`
    });
  }

  // 5. Ball hit into the field -> Trigger 3D Fielding Phase (Ground Roll vs Air Catch vs Dive)
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

  // Determine ball trajectory: 'air_catch' (Pitch 1.3, Whoosh) vs 'ground_roll' (Pitch 0.9, Grass friction)
  const isAirBall = (timingScore < 0.58 && shotDir !== 'defense' && shotPower > 0.55);
  // Determine if fielder needs to dive Left (-0.8), Right (+0.8), or Straight (0.0)
  const needsDive = Math.random() < 0.42;
  const diveDirection = needsDive ? (Math.random() < 0.5 ? 'left' : 'right') : 'center';
  const fielderAudioPan = diveDirection === 'left' ? -0.82 : (diveDirection === 'right' ? 0.82 : 0.0);

  // Pick responsible fielder based on shot direction
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
    diveDirection, // 'center' (double tap), 'left' (swipe left), 'right' (swipe right)
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
      ? `Ball in the air towards ${fielderPosName} (${getPlayerNameBySlot(room, activeFielderSlot)})!`
      : `Ball racing across the turf towards ${fielderPosName} (${getPlayerNameBySlot(room, activeFielderSlot)})!`
  });

  if (isSlotBot(room, activeFielderSlot)) {
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      const botSuccess = Math.random() < 0.72;
      handleFieldingAction(roomCode, activeFielderSlot, {
        actionType: botSuccess ? (needsDive ? `dive_${diveDirection}` : 'catch_or_stop') : 'missed',
        reactionScore: botSuccess ? 0.85 : 0.2,
        throwEnd: Math.random() < 0.6 ? 'batting' : 'bowling',
        throwStraightness: 0.70 + Math.random() * 0.30 // 0.0 to 1.0
      });
    }, 1800);
  } else {
    clearTimeout(g.botActionTimer);
    g.botActionTimer = setTimeout(() => {
      if (g.phase === 'FIELDING_ACTION' && g.currentDelivery?.fieldingState && !g.currentDelivery.fieldingState.resolved) {
        handleFieldingAction(roomCode, activeFielderSlot, {
          actionType: 'missed',
          reactionScore: 0.0
        });
      }
    }, 3200);
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

  const actionType = payload.actionType || 'catch_or_stop'; // 'catch_or_stop', 'dive_left', 'dive_right', 'missed'
  const reactionScore = Number(payload.reactionScore) || 0.75;
  const throwEnd = payload.throwEnd || 'batting'; // 'batting' or 'bowling'
  // throwStraightness (0.0 to 1.0): measures how straight the player swiped towards the stumps!
  const throwStraightness = Math.min(1.0, Math.max(0.0, Number(payload.throwStraightness) || 0.75));

  const correctGesture = fs.needsDive
    ? (actionType === `dive_${fs.diveDirection}`)
    : (actionType === 'catch_or_stop');

  const isFieldedCleanly = correctGesture && reactionScore >= 0.50;

  // 1. If Air Ball & Caught Cleanly -> OUT CAUGHT!
  if (fs.isAirBall && isFieldedCleanly && !g.currentDelivery.isNoBall) {
    return completeBallResolution(roomCode, {
      runs: 0,
      isWicket: true,
      wicketType: 'CAUGHT',
      fielderName: fs.fielderName,
      soundCue: fs.needsDive ? 'diving_catch_roar' : 'clean_catch_roar',
      crowdCue: 'crowd_wicket_celebration',
      commentary: fs.needsDive
        ? `Sensational Diving Catch by ${fs.fielderName} at ${fs.fielderPosName}!`
        : `Caught! ${fs.fielderName} takes a safe catch at ${fs.fielderPosName}!`
    });
  }

  // 2. If Fielder Missed the Dive or Stop -> Ball goes for 2 or 4
  if (!isFieldedCleanly) {
    const boundaryFour = fs.timingScore >= 0.70 && Math.random() < 0.65;
    const runsScored = boundaryFour ? 4 : 2;
    return completeBallResolution(roomCode, {
      runs: runsScored,
      isExtra: g.currentDelivery.isNoBall,
      extraType: g.currentDelivery.isNoBall ? 'NB' : null,
      soundCue: boundaryFour ? 'misfield_boundary_four' : 'batsman_running_two',
      crowdCue: boundaryFour ? 'crowd_cheer_four' : 'crowd_ambient_low',
      commentary: boundaryFour
        ? `Misfield at ${fs.fielderPosName}! The ball races away to the fence for Four!`
        : `Dropped or fumbled by ${fs.fielderName}! The batters scamper back for 2 runs.`
    });
  }

  // 3. Ground Ball Stopped Cleanly -> Evaluate Throw to Stumps (Direct Hit vs Keeper vs Wild Overthrow)
  // Straight swipe (throwStraightness >= 0.88) hits the stumps directly!
  if (throwStraightness >= 0.88 && reactionScore >= 0.75) {
    // Direct Hit Run-Out Chance!
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
        commentary: `Direct Hit at the ${throwEnd} end by ${fs.fielderName}! Huge shout for Run Out!`
      });
    } else {
      return completeBallResolution(roomCode, {
        runs: 0,
        soundCue: 'direct_hit_stump_safe',
        crowdCue: 'crowd_ooh_close',
        commentary: `Brilliant stop and Direct Hit by ${fs.fielderName} at the ${throwEnd} end, but the batter made the ground! Dot ball.`
      });
    }
  } else if (throwStraightness < 0.45) {
    // Diagonal/Poor Swipe -> Misses target, results in 1 run + Overthrow!
    return completeBallResolution(roomCode, {
      runs: 2,
      soundCue: 'throw_missed_stumps_overthrow',
      crowdCue: 'crowd_ooh_close',
      commentary: ` stopped well by ${fs.fielderName}, but a wild throw misses the ${throwEnd} end stumps! They take an extra overthrow run—2 runs!`
    });
  } else {
    // Normal accurate throw into Wicketkeeper/Bowler gloves -> Single or Dot
    const singleTaken = Math.random() < 0.55;
    return completeBallResolution(roomCode, {
      runs: singleTaken ? 1 : 0,
      soundCue: 'throw_collected_gloves',
      crowdCue: 'crowd_ambient_low',
      commentary: singleTaken
        ? `Quick stop by ${fs.fielderName} and thrown to the ${throwEnd} end. Just a quick single.`
        : `Sharp fielding by ${fs.fielderName} at ${fs.fielderPosName}! No run.`
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

  // Realistic human umpire: 82% accurate on close calls, 18% chance of human error (which makes DRS exciting!)
  const isCloseCall = (appealData.type === 'LBW' || appealData.type === 'CAUGHT_BEHIND');
  const umpireMadeError = isCloseCall && (Math.random() < 0.18);
  const onFieldDecision = umpireMadeError ? !appealData.isActuallyOut : appealData.isActuallyOut;

  const canBattingTeamReview = onFieldDecision === true && g.reviewsLeft[g.battingTeam] > 0;
  const canBowlingTeamReview = onFieldDecision === false && g.reviewsLeft[g.bowlingTeam] > 0;

  g.pendingDismissal = {
    ...appealData,
    onFieldDecision, // true = OUT, false = NOT OUT
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
    message: `${appealData.commentary} On-field Umpire gives it ${onFieldDecision ? 'OUT!' : 'NOT OUT!'} (15 seconds for DRS Review)`
  });

  // Auto-resolve after 12 seconds if no DRS taken
  clearTimeout(g.drsTimer);
  g.drsTimer = setTimeout(() => {
    if (g.phase === 'DRS_PENDING' && g.pendingDismissal && !g.pendingDismissal.resolved) {
      finalizeDismissalAfterDrs(roomCode, false);
    }
  }, 12000);
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

  // International ICC Rule: Retain review if overturned OR if Umpire's Call!
  if (!decisionOverturned && !isUmpiresCall) {
    g.reviewsLeft[reviewingTeam] = Math.max(0, g.reviewsLeft[reviewingTeam] - 1);
  }

  // Send Third Umpire step-by-step Audio sequence to all players
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
    message: buildThirdUmpireTranscript(pd, finalDecisionOut, decisionOverturned)
  });

  setTimeout(() => {
    pd.onFieldDecision = finalDecisionOut;
    finalizeDismissalAfterDrs(roomCode, true);
  }, 4500);
}

function buildThirdUmpireTranscript(pd, finalOut, overturned) {
  let text = `Third Umpire Review for ${pd.type}. Fair delivery, front foot is fine. `;
  if (pd.type === 'CAUGHT_BEHIND') {
    text += pd.ultraEdgeSpike
      ? `UltraEdge shows a clear spike as the ball passes the bat! `
      : `UltraEdge shows a flat line, no bat involved. `;
  } else if (pd.type === 'LBW') {
    text += `UltraEdge is flat. Ball Tracking: Pitching ${pd.pitching}, Impact ${pd.impact}, Wickets ${pd.wicketsHitting}. `;
  } else if (pd.type === 'RUN_OUT') {
    text += `Frame by frame replay shows the bails lit up with the batter short of the crease! `;
  }
  text += overturned
    ? `Please reverse your decision to ${finalOut ? 'OUT!' : 'NOT OUT!'}`
    : `Stay with your on-field decision of ${finalOut ? 'OUT!' : 'NOT OUT!'}`;
  return text;
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
      commentary: `OUT! (${pd.type}) ${getPlayerNameBySlot(room, g.strikerSlot)} has to walk back to the pavilion!`
    });
  } else {
    completeBallResolution(roomCode, {
      runs: 0,
      isWicket: false,
      soundCue: 'umpire_not_out',
      crowdCue: 'crowd_ambient_low',
      commentary: `NOT OUT! ${getPlayerNameBySlot(room, g.strikerSlot)} survives the appeal.`
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

  // Rotate strike on odd runs (1 or 3) if 2 batters exist
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
    nonStrikerSlot: g.nonStrikerSlot,
    bowlerSlot: g.currentBowlerSlot,
    batsmanStats: g.batsmanStats,
    bowlerStats: g.bowlerStats,
    soundCue: res.soundCue || 'ball_dot',
    crowdCue: res.crowdCue || 'crowd_ambient_low',
    commentary: res.commentary
  });

  // Check if Innings or Match ended
  if (checkInningsOrMatchEnd(roomCode)) return;

  // Check if a Wicket fell and more batters are available -> Ask Batting Captain to choose next batsman!
  if (isWicket) {
    const availableBatters = getAvailableBatters(room, g);
    if (availableBatters.length > 0) {
      setTimeout(() => promptCaptainForNextBatsman(roomCode, availableBatters), 2200);
      return;
    }
  }

  // Check if Over Completed (6 legal balls)
  if (g.ballsInCurrentOver >= 6) {
    handleEndOfOver(roomCode);
  } else {
    setTimeout(() => startNextBallPrep(roomCode), 2200);
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

  // Rotate strike at end of over
  if (g.nonStrikerSlot !== -1) {
    const tmp = g.strikerSlot;
    g.strikerSlot = g.nonStrikerSlot;
    g.nonStrikerSlot = tmp;
  }

  if (checkInningsOrMatchEnd(roomCode)) return;

  setTimeout(() => promptCaptainForNextBowler(roomCode, false), 2200);
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
    message: `Wicket fallen! Captain ${getPlayerNameBySlot(room, batCaptainSlot)}, select the next batter to walk in.`
  });

  if (isSlotBot(room, batCaptainSlot) || battersList.length === 1) {
    setTimeout(() => applyNextBatsmanSelection(roomCode, battersList[0].slot), 1800);
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
    message: `${getPlayerNameBySlot(room, slot)} walks in to bat!`
  });

  if (g.ballsInCurrentOver >= 6) {
    handleEndOfOver(roomCode);
  } else {
    setTimeout(() => startNextBallPrep(roomCode), 1500);
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
    g.batsmanStats[targetBatterSlot].outDesc = 'Retired Tactically';
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
    message: `Captain tactical call: ${oldName} retires and ${newName} comes in to bat!`
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
    message: `Captain moved ${fName} to ${posName}.`
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
      message: `End of 1st Innings! ${firstBatName} scored ${g.score}/${g.wickets}. ${secondBatName} needs ${g.target} runs in ${g.totalOvers} overs to win!`
    });

    // Switch roles for 2nd Innings after 5 seconds
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
    }, 5000);

    return true;
  }

  // 2nd Innings Finished -> Match Over!
  g.phase = 'MATCH_OVER';
  let winningTeam = null;
  let resultText = '';

  const batTeamName = g.battingTeam === 'A' ? room.teamAName : room.teamBName;
  const bowlTeamName = g.bowlingTeam === 'A' ? room.teamAName : room.teamBName;

  if (g.score >= g.target) {
    winningTeam = g.battingTeam;
    const wktsLeft = Math.max(1, g.maxWickets - g.wickets);
    resultText = `${batTeamName} won the match by ${wktsLeft} wicket(s)!`;
  } else if (g.score === g.target - 1) {
    winningTeam = 'TIE';
    resultText = `What a thriller! The match is TIED!`;
  } else {
    winningTeam = g.bowlingTeam;
    const runMargin = (g.target - 1) - g.score;
    resultText = `${bowlTeamName} won the match by ${runMargin} run(s)!`;
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
    case 'REQUEST_SYNC':
      cricketRoomManager.gameEvent(roomCode, 'SYNC_STATE', {
        phase: g.phase,
        innings: g.innings,
        score: g.score,
        wickets: g.wickets,
        totalOvers: g.totalOvers,
        ballsBowledInInnings: g.ballsBowledInInnings,
        target: g.target,
        battingTeam: g.battingTeam,
        bowlingTeam: g.bowlingTeam,
        strikerSlot: g.strikerSlot,
        nonStrikerSlot: g.nonStrikerSlot,
        currentBowlerSlot: g.currentBowlerSlot,
        currentBowlerStyle: g.currentBowlerStyle,
        fieldingMap: g.fieldingMap,
        batsmanStats: g.batsmanStats,
        bowlerStats: g.bowlerStats,
        reviewsLeft: g.reviewsLeft,
        teamAName: room.teamAName,
        teamBName: room.teamBName
      }, playerId);
      break;

    case 'ACTION_TOSS_DECISION':
      if (senderSlot === getCaptainSlot(room, g.tossWinnerTeam)) {
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

  // If disconnected player was active bowler, batter, or captain in a prompt, trigger bot fallback
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