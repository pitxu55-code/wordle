const socket = io();

// ---------- State ----------
let myId = null;
let currentRoom = null; // last room_update payload
let isHost = false;
let gameConfig = null; // {length, maxAttempts, language, timerEnabled, timerSeconds}
let myAttempts = []; // [{guess, pattern, skipped}]
let currentGuess = '';
let gameOver = false;
let countdownInterval = null;
let countdownEndsAt = null;

const KEY_ROWS = {
  en: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  fr: ['AZERTYUIOP', 'QSDFGHJKLM', 'WXCVBN']
};

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

// ---------- Home screen ----------
$('btn-create').addEventListener('click', () => {
  const name = $('input-name').value.trim() || 'Player';
  socket.emit('create_room', { name, settings: currentSettingsFromUI() }, (res) => {
    if (!res.ok) return alert(res.error || 'Could not create room');
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('input-name').value.trim() || 'Player';
  const code = $('input-code').value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_room', { code, name }, (res) => {
    if (!res.ok) {
      $('lobby-msg').textContent = '';
      alert(res.error || 'Could not join room');
    }
  });
});

$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

function currentSettingsFromUI() {
  return {
    length: parseInt($('setting-length').querySelector('.active')?.dataset.val || '5', 10),
    language: $('setting-language').querySelector('.active')?.dataset.val || 'en',
    timerEnabled: $('setting-timer-enabled').checked,
    timerSeconds: parseInt($('setting-timer-seconds').value || '10', 10),
    attempts: parseInt($('setting-attempts').value || '6', 10),
    rounds: parseInt($('setting-rounds').value || '1', 10)
  };
}

function defaultAttemptsForLength(len) {
  return 6 + (len - 5);
}

// ---------- Settings UI (lobby) ----------
function wireSegmented(containerId, defaultVal, onChange) {
  const container = $(containerId);
  container.querySelectorAll('button').forEach(btn => {
    if (btn.dataset.val === String(defaultVal)) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange();
    });
  });
}

function pushSettingsIfHost() {
  if (!isHost) return;
  socket.emit('update_settings', currentSettingsFromUI());
}

let attemptsManuallySet = false;

wireSegmented('setting-length', 5, () => {
  if (!attemptsManuallySet) applyAutoAttempts();
  pushSettingsIfHost();
});
wireSegmented('setting-language', 'en', pushSettingsIfHost);
$('setting-timer-enabled').addEventListener('change', pushSettingsIfHost);
$('setting-timer-seconds').addEventListener('change', pushSettingsIfHost);

$('setting-attempts').addEventListener('input', () => {
  attemptsManuallySet = true;
});
$('setting-attempts').addEventListener('change', pushSettingsIfHost);
$('setting-rounds').addEventListener('change', pushSettingsIfHost);

$('btn-attempts-auto').addEventListener('click', () => {
  attemptsManuallySet = false;
  applyAutoAttempts();
  pushSettingsIfHost();
});

function applyAutoAttempts() {
  const len = parseInt($('setting-length').querySelector('.active')?.dataset.val || '5', 10);
  $('setting-attempts').value = defaultAttemptsForLength(len);
}
applyAutoAttempts();

function setSettingsUI(settings) {
  $('setting-length').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === String(settings.length)));
  $('setting-language').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === settings.language));
  $('setting-timer-enabled').checked = settings.timerEnabled;
  $('setting-timer-seconds').value = settings.timerSeconds;
  $('setting-attempts').value = settings.attempts;
  attemptsManuallySet = settings.attempts !== defaultAttemptsForLength(settings.length);
  $('setting-rounds').value = settings.rounds;
}

function lockSettingsUI(locked) {
  document.querySelectorAll('#settings-card button, #settings-card input').forEach(el => {
    el.disabled = locked;
  });
  $('settings-lock').textContent = locked ? '(only the host can change these)' : '';
}

// ---------- Lobby ----------
$('btn-start').addEventListener('click', () => socket.emit('start_game'));
$('btn-leave').addEventListener('click', () => {
  socket.emit('leave_room');
  currentRoom = null;
  showScreen('home');
});

function renderLobby(room) {
  $('lobby-code').textContent = room.code;
  isHost = room.hostId === myId;
  lockSettingsUI(!isHost);
  setSettingsUI(room.settings);

  $('lobby-players').innerHTML = '';
  room.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span><i class="dot ${p.connected ? '' : 'off'}"></i>${escapeHtml(p.name)}${p.id === room.hostId ? '<span class="tag-host">HOST</span>' : ''}</span>`;
    $('lobby-players').appendChild(li);
  });

  $('btn-start').style.display = isHost ? 'inline-block' : 'none';
  $('lobby-msg').textContent = isHost ? '' : 'Waiting for host to start the game…';
}

// ---------- Game screen ----------
function startGameUI(config) {
  gameConfig = config;
  myAttempts = [];
  currentGuess = '';
  gameOver = false;
  $('game-code').textContent = currentRoom ? currentRoom.code : '';
  buildBoard(config.length, config.maxAttempts);
  buildKeyboard(config.language);
  $('msg-banner').textContent = '';
  showScreen('game');
  updateTimerBadgeVisibility(config.timerEnabled);

  const roundBadge = $('round-badge');
  if (config.totalRounds > 1) {
    roundBadge.textContent = `Round ${config.round}/${config.totalRounds}`;
    roundBadge.classList.remove('hidden');
  } else {
    roundBadge.classList.add('hidden');
  }

  $('btn-stop-game').classList.toggle('hidden', !isHost);
}

function buildBoard(length, maxAttempts) {
  const board = $('board');
  board.innerHTML = '';
  for (let r = 0; r < maxAttempts; r++) {
    const row = document.createElement('div');
    row.className = 'board-row';
    row.dataset.row = r;
    for (let c = 0; c < length; c++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.col = c;
      row.appendChild(tile);
    }
    board.appendChild(row);
  }
}

function buildKeyboard(language) {
  const kb = $('keyboard');
  kb.innerHTML = '';
  const rows = KEY_ROWS[language] || KEY_ROWS.en;
  rows.forEach((rowStr, i) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'kb-row';
    if (i === rows.length - 1) {
      rowEl.appendChild(makeKey('ENTER', 'wide'));
    }
    rowStr.split('').forEach(ch => rowEl.appendChild(makeKey(ch)));
    if (i === rows.length - 1) {
      rowEl.appendChild(makeKey('DEL', 'wide'));
    }
    kb.appendChild(rowEl);
  });
}

function makeKey(label, extraClass) {
  const btn = document.createElement('button');
  btn.className = 'key' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = label === 'DEL' ? '⌫' : label;
  btn.dataset.key = label;
  btn.addEventListener('click', () => handleKeyInput(label));
  return btn;
}

function handleKeyInput(label) {
  if (gameOver) return;
  const rowIndex = myAttempts.length;
  if (rowIndex >= gameConfig.maxAttempts) return;

  if (label === 'ENTER') {
    submitGuess();
  } else if (label === 'DEL') {
    currentGuess = currentGuess.slice(0, -1);
    renderCurrentRow();
  } else {
    if (currentGuess.length < gameConfig.length) {
      currentGuess += label.toLowerCase();
      renderCurrentRow();
    }
  }
}

document.addEventListener('keydown', (e) => {
  if (!$('screen-game').classList.contains('active')) return;
  if (gameOver) return;
  const k = e.key;
  if (k === 'Enter') return handleKeyInput('ENTER');
  if (k === 'Backspace') return handleKeyInput('DEL');
  if (/^[a-zA-ZÀ-ÿ]$/.test(k)) return handleKeyInput(k.toUpperCase());
});

function renderCurrentRow() {
  const rowIndex = myAttempts.length;
  const row = document.querySelector(`.board-row[data-row="${rowIndex}"]`);
  if (!row) return;
  const tiles = row.querySelectorAll('.tile');
  tiles.forEach((tile, i) => {
    const ch = currentGuess[i];
    tile.textContent = ch || '';
    tile.classList.toggle('filled', !!ch);
  });
}

function submitGuess() {
  if (currentGuess.length !== gameConfig.length) {
    flashMessage(`Word must be ${gameConfig.length} letters.`);
    return;
  }
  socket.emit('submit_guess', currentGuess);
}

function flashMessage(text) {
  const banner = $('msg-banner');
  banner.textContent = text;
  setTimeout(() => { if (banner.textContent === text) banner.textContent = ''; }, 2200);
}

function renderMyAttempts(attempts) {
  myAttempts = attempts;
  attempts.forEach((att, r) => {
    const row = document.querySelector(`.board-row[data-row="${r}"]`);
    if (!row) return;
    const tiles = row.querySelectorAll('.tile');
    if (att.skipped) {
      tiles.forEach(t => { t.classList.add('skip'); t.textContent = ''; });
      return;
    }
    att.guess.split('').forEach((ch, c) => {
      const tile = tiles[c];
      tile.textContent = ch;
      tile.classList.add('filled', 'pop', att.pattern[c]);
      updateKeyColor(ch, att.pattern[c]);
    });
  });
  currentGuess = '';
  const nextRow = document.querySelector(`.board-row[data-row="${attempts.length}"]`);
  if (nextRow) nextRow.classList.add('current');
}

function updateKeyColor(ch, state) {
  const btn = document.querySelector(`.key[data-key="${ch.toUpperCase()}"]`);
  if (!btn) return;
  const rank = { absent: 0, present: 1, correct: 2 };
  const cur = btn.dataset.state || 'absent';
  if (!btn.dataset.state || rank[state] >= rank[cur]) {
    btn.classList.remove('correct', 'present', 'absent');
    btn.classList.add(state);
    btn.dataset.state = state;
  }
}

// ---------- Opponents bar ----------
function renderOpponents(room) {
  const bar = $('opponents-bar');
  bar.innerHTML = '';
  room.players.filter(p => p.id !== myId).forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'opp-chip' + (p.finished ? ' finished' : '');
    const dots = p.pattern.slice(0, p.maxAttempts).map(pat => {
      if (!pat) return '<i></i>';
      const solved = pat.every(x => x === 'correct');
      const hasPresent = pat.some(x => x === 'present');
      const cls = solved ? 'correct' : (hasPresent ? 'present' : '');
      return `<i class="${cls}"></i>`;
    }).join('');
    chip.innerHTML = `<span class="opp-name">${escapeHtml(p.name)}</span><span class="opp-dots">${dots}</span>${p.finished ? `<span class="opp-score">${p.score}</span>` : ''}`;
    bar.appendChild(chip);
  });
}

// ---------- Timer ----------
function updateTimerBadgeVisibility(enabled) {
  $('timer-badge').classList.toggle('hidden', !enabled);
}

function restartRowCountdown(seconds) {
  clearInterval(countdownInterval);
  if (!gameConfig || !gameConfig.timerEnabled) return;
  countdownEndsAt = Date.now() + seconds * 1000;
  updateTimerDisplay();
  countdownInterval = setInterval(updateTimerDisplay, 250);
}

function updateTimerDisplay() {
  if (!countdownEndsAt) return;
  const remaining = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
  $('timer-value').textContent = remaining;
  $('timer-badge').classList.toggle('urgent', remaining <= 3);
  if (remaining <= 0) clearInterval(countdownInterval);
}

// ---------- Results ----------
function renderResults(payload) {
  gameOver = true;
  clearInterval(countdownInterval);
  $('reveal-word').textContent = payload.secret;

  const isFinal = payload.isFinalRound;
  const multiRound = payload.totalRounds > 1;

  if (isFinal) {
    $('results-title').textContent = multiRound
      ? `Final Results — ${payload.totalRounds} Rounds`
      : 'Round Over';
  } else {
    $('results-title').textContent = `Round ${payload.round} of ${payload.totalRounds} Complete`;
  }

  // Rank by cumulative total once rounds are involved, otherwise by this round's score
  const rankKey = multiRound ? 'totalScore' : 'score';
  const sorted = [...payload.players].sort((a, b) => b[rankKey] - a[rankKey]);
  $('results-list').innerHTML = '';
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    const sub = p.solved ? `solved in ${p.attemptsUsed}` : 'not solved';
    const scoreLine = multiRound
      ? `<span class="rscore">${p.totalScore} pts</span>`
      : `<span class="rscore">${p.score} pts</span>`;
    const roundSub = multiRound ? `${sub} · this round: ${p.score} pts` : sub;
    li.innerHTML = `<span><span class="rname">${i === 0 ? '🏆 ' : ''}${escapeHtml(p.name)}</span><br><span class="rsub">${roundSub}</span></span>${scoreLine}`;
    $('results-list').appendChild(li);
  });

  $('btn-next-round').classList.toggle('hidden', isFinal || !isHost);
  $('btn-rematch').classList.toggle('hidden', !isFinal || !isHost);
  $('btn-stop-game-results').classList.toggle('hidden', isFinal || !isHost);
  $('results-wait-msg').textContent = isHost ? '' : (isFinal ? '' : 'Waiting for host to start the next round…');

  showScreen('results');
}

$('btn-next-round').addEventListener('click', () => socket.emit('next_round'));
$('btn-rematch').addEventListener('click', () => socket.emit('rematch'));
$('btn-home').addEventListener('click', () => {
  socket.emit('leave_room');
  currentRoom = null;
  showScreen('home');
});

// ---------- Stop game (host) ----------
function openStopConfirm() {
  $('stop-confirm').classList.remove('hidden');
}
function closeStopConfirm() {
  $('stop-confirm').classList.add('hidden');
}
$('btn-stop-game').addEventListener('click', openStopConfirm);
$('btn-stop-game-results').addEventListener('click', openStopConfirm);
$('btn-stop-confirm-no').addEventListener('click', closeStopConfirm);
$('btn-stop-confirm-yes').addEventListener('click', () => {
  socket.emit('stop_game');
  closeStopConfirm();
});

// ---------- Socket events ----------
socket.on('connect', () => { myId = socket.id; });

socket.on('room_update', (room) => {
  currentRoom = room;
  isHost = room.hostId === myId;
  if (room.status === 'lobby') {
    clearInterval(countdownInterval);
    gameConfig = null;
    myAttempts = [];
    currentGuess = '';
    gameOver = false;
    closeStopConfirm();
    renderLobby(room);
    showScreen('lobby');
  } else if (room.status === 'playing') {
    renderOpponents(room);
    $('btn-stop-game').classList.toggle('hidden', !isHost);
  } else if (room.status === 'round_over' || room.status === 'finished') {
    renderOpponents(room);
    // Keep the results screen's button visibility in sync if host status changes mid-wait
    if ($('screen-results').classList.contains('active')) {
      const isFinal = room.status === 'finished';
      $('btn-next-round').classList.toggle('hidden', isFinal || !isHost);
      $('btn-rematch').classList.toggle('hidden', !isFinal || !isHost);
      $('btn-stop-game-results').classList.toggle('hidden', isFinal || !isHost);
      $('results-wait-msg').textContent = isHost ? '' : (isFinal ? '' : 'Waiting for host to start the next round…');
    }
  }
});

socket.on('game_start', (config) => {
  startGameUI(config);
  if (config.timerEnabled) restartRowCountdown(config.timerSeconds);
});

socket.on('your_attempts', ({ attempts }) => {
  renderMyAttempts(attempts);
  if (gameConfig && gameConfig.timerEnabled && attempts.length < gameConfig.maxAttempts) {
    restartRowCountdown(gameConfig.timerSeconds);
  } else {
    clearInterval(countdownInterval);
  }
  const last = attempts[attempts.length - 1];
  if (last && !last.skipped && last.pattern.every(p => p === 'correct')) {
    flashMessage('You solved it! 🎉');
  } else if (attempts.length >= (gameConfig ? gameConfig.maxAttempts : Infinity)) {
    flashMessage('Out of attempts — waiting for opponent…');
  }
});

socket.on('guess_error', ({ error }) => flashMessage(error));

socket.on('game_over', (payload) => renderResults(payload));

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
