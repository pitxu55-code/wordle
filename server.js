const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Load dictionaries ----------
const WORDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf-8'));
// WORDS = { en: {5:[...],6:[...],7:[...],8:[...]}, fr: {...} }
const WORD_SETS = {}; // WORD_SETS[lang][len] = Set
for (const lang of Object.keys(WORDS)) {
  WORD_SETS[lang] = {};
  for (const len of Object.keys(WORDS[lang])) {
    WORD_SETS[lang][len] = new Set(WORDS[lang][len]);
  }
}

function randomWord(lang, len) {
  const list = WORDS[lang][String(len)];
  return list[Math.floor(Math.random() * list.length)];
}

function isValidWord(lang, len, guess) {
  const set = WORD_SETS[lang] && WORD_SETS[lang][String(len)];
  return !!set && set.has(guess);
}

// ---------- Room management ----------
const rooms = new Map(); // code -> room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function defaultAttemptsFor(len) {
  // 5 letters -> 6 attempts, +1 attempt per extra letter (used as a fallback default)
  return 6 + (len - 5);
}

function publicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,
    round: room.round,
    totalRounds: room.settings.rounds,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      finished: p.finished,
      solved: p.solved,
      score: p.score,
      totalScore: p.totalScore,
      attemptsUsed: p.attempts.length,
      maxAttempts: room.maxAttempts,
      pattern: p.attempts.map(a => a ? a.pattern : null) // colors only, no letters, for opponents
    }))
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', publicRoomState(room));
}

function clearPlayerTimer(player) {
  if (player.timer) {
    clearTimeout(player.timer);
    player.timer = null;
  }
}

function startPlayerTimer(room, player) {
  clearPlayerTimer(player);
  if (!room.settings.timerEnabled) return;
  player.timer = setTimeout(() => {
    // Time's up: skip this row (counts as a used, empty attempt)
    if (player.finished) return;
    player.attempts.push({ guess: null, pattern: null, skipped: true });
    checkPlayerDone(room, player);
    if (!player.finished) startPlayerTimer(room, player);
    broadcastRoom(room);
    io.to(player.id).emit('your_attempts', { attempts: player.attempts });
  }, room.settings.timerSeconds * 1000);
}

function computePattern(secret, guess) {
  const len = secret.length;
  const pattern = new Array(len).fill('absent');
  const secretArr = secret.split('');
  const guessArr = guess.split('');
  const used = new Array(len).fill(false);

  for (let i = 0; i < len; i++) {
    if (guessArr[i] === secretArr[i]) {
      pattern[i] = 'correct';
      used[i] = true;
    }
  }
  for (let i = 0; i < len; i++) {
    if (pattern[i] === 'correct') continue;
    let foundIdx = -1;
    for (let j = 0; j < len; j++) {
      if (!used[j] && secretArr[j] === guessArr[i]) {
        foundIdx = j;
        break;
      }
    }
    if (foundIdx !== -1) {
      pattern[i] = 'present';
      used[foundIdx] = true;
    }
  }
  return pattern;
}

function scoreForAttempt(attemptNumber, maxAttempts) {
  // attemptNumber is 1-indexed
  return (maxAttempts - attemptNumber) + 1;
}

function checkPlayerDone(room, player) {
  const last = player.attempts[player.attempts.length - 1];
  if (last && last.pattern && last.pattern.every(p => p === 'correct')) {
    player.solved = true;
    player.finished = true;
    player.score = scoreForAttempt(player.attempts.length, room.maxAttempts);
    clearPlayerTimer(player);
  } else if (player.attempts.length >= room.maxAttempts) {
    player.finished = true;
    player.score = 0;
    clearPlayerTimer(player);
  }
  if (player.finished) {
    maybeEndGame(room);
  }
}

function startRound(room) {
  room.secretWord = randomWord(room.settings.language, room.settings.length);
  room.maxAttempts = room.settings.attempts;
  for (const p of room.players.values()) {
    p.attempts = [];
    p.solved = false;
    p.finished = false;
    p.score = 0;
    clearPlayerTimer(p);
  }
  room.status = 'playing';
  io.to(room.code).emit('game_start', {
    length: room.settings.length,
    maxAttempts: room.maxAttempts,
    language: room.settings.language,
    timerEnabled: room.settings.timerEnabled,
    timerSeconds: room.settings.timerSeconds,
    round: room.round,
    totalRounds: room.settings.rounds
  });
  for (const p of room.players.values()) {
    startPlayerTimer(room, p);
  }
  broadcastRoom(room);
}

function maybeEndGame(room) {
  const allFinished = Array.from(room.players.values()).every(p => p.finished || !p.connected);
  if (allFinished && room.status === 'playing') {
    for (const p of room.players.values()) {
      clearPlayerTimer(p);
      p.totalScore = (p.totalScore || 0) + p.score;
    }
    const isFinalRound = room.round >= room.settings.rounds;
    room.status = isFinalRound ? 'finished' : 'round_over';
    io.to(room.code).emit('game_over', {
      secret: room.secretWord,
      round: room.round,
      totalRounds: room.settings.rounds,
      isFinalRound,
      players: Array.from(room.players.values()).map(p => ({
        id: p.id, name: p.name, score: p.score, totalScore: p.totalScore,
        solved: p.solved, attemptsUsed: p.attempts.length
      }))
    });
    broadcastRoom(room);
  }
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('create_room', ({ name, settings }, cb) => {
    const code = genCode();
    const clean = sanitizeSettings(settings);
    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      settings: clean,
      players: new Map(),
      secretWord: null,
      round: 0,
      maxAttempts: clean.attempts
    };
    rooms.set(code, room);
    joinRoomInternal(socket, room, name || 'Player');
    cb && cb({ ok: true, code });
  });

  socket.on('join_room', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, error: 'Room not found' });
    if (room.status === 'playing' || room.status === 'round_over') {
      return cb && cb({ ok: false, error: 'Game already in progress' });
    }
    joinRoomInternal(socket, room, name || 'Player');
    cb && cb({ ok: true, code: room.code });
  });

  function joinRoomInternal(socket, room, name) {
    socket.join(room.code);
    socket.data.roomCode = room.code;
    room.players.set(socket.id, {
      id: socket.id,
      name,
      connected: true,
      attempts: [],
      solved: false,
      finished: false,
      score: 0,
      totalScore: 0,
      timer: null
    });
    broadcastRoom(room);
  }

  socket.on('update_settings', (settings) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    room.settings = sanitizeSettings(settings);
    room.maxAttempts = room.settings.attempts;
    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.players.size < 1) return;
    room.round = 1;
    for (const p of room.players.values()) p.totalScore = 0;
    startRound(room);
  });

  socket.on('next_round', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'round_over') return;
    if (room.round >= room.settings.rounds) return;
    room.round += 1;
    startRound(room);
  });

  socket.on('submit_guess', (guessRaw) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.finished) return;

    const guess = String(guessRaw || '').toLowerCase().trim();
    if (guess.length !== room.settings.length) {
      socket.emit('guess_error', { error: `Word must be ${room.settings.length} letters.` });
      return;
    }
    if (!isValidWord(room.settings.language, room.settings.length, guess)) {
      socket.emit('guess_error', { error: 'Not in dictionary.' });
      return;
    }
    const pattern = computePattern(room.secretWord, guess);
    player.attempts.push({ guess, pattern, skipped: false });
    checkPlayerDone(room, player);
    if (!player.finished) startPlayerTimer(room, player);

    socket.emit('your_attempts', { attempts: player.attempts });
    broadcastRoom(room);
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.status = 'lobby';
    room.secretWord = null;
    room.round = 0;
    for (const p of room.players.values()) {
      p.attempts = [];
      p.solved = false;
      p.finished = false;
      p.score = 0;
      p.totalScore = 0;
      clearPlayerTimer(p);
    }
    broadcastRoom(room);
  });

  socket.on('leave_room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket, true);
  });

  function leaveCurrentRoom(socket, disconnected) {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) clearPlayerTimer(player);

    if (disconnected) {
      if (player) player.connected = false;
    } else {
      room.players.delete(socket.id);
      socket.leave(code);
    }
    socket.data.roomCode = null;

    const stillConnected = Array.from(room.players.values()).some(p => p.connected);
    if (!stillConnected || room.players.size === 0) {
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) {
      const next = Array.from(room.players.values()).find(p => p.connected);
      if (next) room.hostId = next.id;
    }
    if (room.status === 'playing') maybeEndGame(room);
    broadcastRoom(room);
  }
});

function sanitizeSettings(s) {
  s = s || {};
  let length = parseInt(s.length, 10);
  if (!Number.isFinite(length) || length < 5) length = 5;
  if (length > 8) length = 8;
  let language = (s.language === 'fr') ? 'fr' : 'en';
  let timerEnabled = !!s.timerEnabled;
  let timerSeconds = parseInt(s.timerSeconds, 10);
  if (!Number.isFinite(timerSeconds) || timerSeconds < 5) timerSeconds = 10;
  if (timerSeconds > 120) timerSeconds = 120;
  let attempts = parseInt(s.attempts, 10);
  if (!Number.isFinite(attempts) || attempts < 2) attempts = defaultAttemptsFor(length);
  if (attempts > 20) attempts = 20;
  let rounds = parseInt(s.rounds, 10);
  if (!Number.isFinite(rounds) || rounds < 1) rounds = 1;
  if (rounds > 20) rounds = 20;
  return { length, language, timerEnabled, timerSeconds, attempts, rounds };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Duel Wordle server running on port ${PORT}`);
});
