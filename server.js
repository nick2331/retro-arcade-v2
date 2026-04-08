const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/play',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const GAMES = [
  { id: 0, name: 'BREAKOUT',   emoji: '🧱', desc: 'Rompe todos los bloques' },
  { id: 1, name: 'SNAKE',      emoji: '🐍', desc: 'Come y crece sin morir'  },
  { id: 2, name: 'SPACE INV.', emoji: '🚀', desc: 'Destruye los aliens'     },
  { id: 3, name: 'TETRIS',     emoji: '🟦', desc: 'Completa líneas'         },
];
const ROUND_SECS = 60;

const state = {
  players: {}, phase: 'lobby', currentGame: -1,
  roundScores: [], gameTimeout: null,
};

function getPlayerList() {
  return Object.values(state.players).map(p => ({
    name: p.name, score: p.score, lives: p.lives, alive: p.alive,
  }));
}
function getRanking() {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, totalScore: p.totalScore || 0 }));
}
function broadcastState() {
  io.emit('state_update', {
    players: getPlayerList(),
    playerCount: Object.values(state.players).length,
    phase: state.phase,
    currentGame: state.currentGame,
    game: state.currentGame >= 0 ? GAMES[state.currentGame] : null,
    totalGames: GAMES.length,
  });
}

function launchRound(idx) {
  if (idx >= GAMES.length) {
    state.phase = 'done';
    // Final ranking uses totalScore
    const finalRanking = Object.values(state.players)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((p, i) => ({ rank: i + 1, name: p.name, score: p.totalScore }));
    io.emit('competition_end', { ranking: finalRanking });
    broadcastState();
    return;
  }
  state.currentGame = idx;
  state.phase = 'countdown';
  const livesForRound = idx === 3 ? 1 : 3; // Tetris: 1 vida
  Object.keys(state.players).forEach(id => {
    state.players[id].score = 0;
    state.players[id].lives = livesForRound;
    state.players[id].alive = true;
  });
  io.emit('round_start', {
      gameIdx: idx, game: GAMES[idx],
      duration: ROUND_SECS, roundNum: idx + 1, totalGames: GAMES.length,
      livesCount: idx === 3 ? 1 : 3,
    });
  broadcastState();
  setTimeout(() => {
    state.phase = 'playing';
    io.emit('round_start', {
      gameIdx: idx, game: GAMES[idx],
      duration: ROUND_SECS, roundNum: idx + 1, totalGames: GAMES.length,
    });
    broadcastState();
    clearTimeout(state.gameTimeout);
    state.gameTimeout = setTimeout(() => endRound(idx), (ROUND_SECS + 2) * 1000);
  }, 4000);
}

function endRound(idx) {
  if (state.phase !== 'playing') return;
  clearTimeout(state.gameTimeout);
  // Add round score to totalScore
  Object.keys(state.players).forEach(id => {
    state.players[id].totalScore = (state.players[id].totalScore || 0) + state.players[id].score;
  });
  const ranking = getRanking();
  state.roundScores.push({ game: GAMES[idx], ranking });
  state.phase = 'results';
  io.emit('round_end', {
    game: GAMES[idx], ranking,
    nextGame: idx + 1 < GAMES.length ? GAMES[idx + 1] : null,
    isLast: idx + 1 >= GAMES.length,
    roundNum: idx + 1, totalGames: GAMES.length,
  });
  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('player_join', ({ name }) => {
    const clean = String(name).toUpperCase().replace(/\s/g, '_').slice(0, 12);
    if (Object.values(state.players).find(p => p.name === clean)) {
      socket.emit('join_error', { msg: 'Ese nombre ya está en uso' }); return;
    }
    state.players[socket.id] = { name: clean, score: 0, totalScore: 0, lives: 3, alive: true };
    socket.emit('join_ok', {
      name: clean, phase: state.phase,
      game: state.currentGame >= 0 ? GAMES[state.currentGame] : null,
    });
    broadcastState();
  });

  socket.on('admin_start',      () => { if (state.phase !== 'lobby') return; state.roundScores = []; launchRound(0); });
  socket.on('admin_next_round', () => { if (state.phase !== 'results') return; launchRound(state.currentGame + 1); });
  socket.on('admin_end_round',  () => { if (state.phase === 'playing') endRound(state.currentGame); });
  socket.on('admin_reset', () => {
    clearTimeout(state.gameTimeout);
    state.phase = 'lobby'; state.currentGame = -1; state.roundScores = [];
    Object.keys(state.players).forEach(id => {
      state.players[id].score = 0; state.players[id].lives = 3; state.players[id].alive = true;
    });
    io.emit('room_reset'); broadcastState();
  });

  socket.on('score_update', ({ score }) => {
    if (state.players[socket.id] && state.phase === 'playing') {
      state.players[socket.id].score = score;
      io.emit('live_ranking', getRanking());
    }
  });
  socket.on('life_lost', ({ lives, score }) => {
    if (!state.players[socket.id]) return;
    state.players[socket.id].lives = lives;
    state.players[socket.id].score = score;
    if (lives <= 0) state.players[socket.id].alive = false;
    io.emit('live_ranking', getRanking()); broadcastState();
  });
  socket.on('player_game_over', ({ score }) => {
    if (state.players[socket.id]) {
      state.players[socket.id].score = score;
      state.players[socket.id].alive = false;
      state.players[socket.id].lives = 0;
    }
    io.emit('live_ranking', getRanking());
  });
  socket.on('disconnect', () => {
    if (state.players[socket.id]) { delete state.players[socket.id]; broadcastState(); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Retro Arcade on port ${PORT}`));
