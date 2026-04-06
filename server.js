const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Static files ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ─────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ─── Game State ──────────────────────────────────────────────
const state = {
  players: {},       // socketId -> { name, score, game, connected }
  gameActive: false,
  currentGame: null, // 0-3
  gameStartTime: null,
  scores: [],        // historical scores
};

const GAMES = [
  { id: 0, name: 'BREAKOUT',   emoji: '🧱', desc: 'Rompe todos los bloques' },
  { id: 1, name: 'SNAKE',      emoji: '🐍', desc: 'Come y crece sin morir' },
  { id: 2, name: 'SPACE INV.', emoji: '🚀', desc: 'Destruye los aliens' },
  { id: 3, name: 'TETRIS',     emoji: '🟦', desc: 'Completa líneas' },
];

// ─── Helpers ─────────────────────────────────────────────────
function getPlayerList() {
  return Object.values(state.players).map(p => ({
    name: p.name,
    score: p.score,
    game: p.game,
  }));
}

function getRanking() {
  return Object.values(state.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

function broadcastState() {
  io.emit('state_update', {
    players: getPlayerList(),
    playerCount: Object.values(state.players).length,
    gameActive: state.gameActive,
    currentGame: state.currentGame,
  });
}

// ─── Socket.io Events ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // ── Player joins ──
  socket.on('player_join', ({ name }) => {
    const cleanName = String(name).toUpperCase().replace(/\s/g, '_').slice(0, 12);
    // Check duplicate
    const taken = Object.values(state.players).find(p => p.name === cleanName);
    if (taken) {
      socket.emit('join_error', { msg: 'Ese nombre ya está en uso' });
      return;
    }
    state.players[socket.id] = {
      name: cleanName,
      score: 0,
      game: state.currentGame !== null ? GAMES[state.currentGame]?.name : null,
      socketId: socket.id,
    };
    socket.emit('join_ok', {
      name: cleanName,
      gameActive: state.gameActive,
      currentGame: state.currentGame,
      games: GAMES,
    });
    // Tell admin + everyone
    broadcastState();
    console.log(`👤 Player joined: ${cleanName}`);
  });

  // ── Admin selects game ──
  socket.on('admin_select_game', ({ gameId }) => {
    if (gameId < 0 || gameId >= GAMES.length) return;
    state.currentGame = gameId;
    io.emit('game_selected', { game: GAMES[gameId] });
    broadcastState();
    console.log(`🎮 Game selected: ${GAMES[gameId].name}`);
  });

  // ── Admin starts game ──
  socket.on('admin_start_game', ({ gameId }) => {
    if (gameId === undefined || gameId === null) return;
    state.currentGame = gameId;
    state.gameActive = true;
    state.gameStartTime = Date.now();

    // Reset scores for this round
    Object.keys(state.players).forEach(id => {
      state.players[id].score = 0;
      state.players[id].game = GAMES[gameId].name;
    });

    io.emit('game_start', { gameId, game: GAMES[gameId] });
    broadcastState();
    console.log(`🚀 Game started: ${GAMES[gameId].name}`);

    // Auto-end after 65 seconds
    setTimeout(() => {
      if (state.gameActive) {
        state.gameActive = false;
        const ranking = getRanking();
        // Save to history
        state.scores.push({
          game: GAMES[gameId].name,
          ts: new Date().toISOString(),
          ranking,
        });
        io.emit('game_end', { ranking, game: GAMES[gameId] });
        broadcastState();
        console.log('⏱ Game ended (timeout)');
      }
    }, 65000);
  });

  // ── Player updates score ──
  socket.on('score_update', ({ score }) => {
    if (state.players[socket.id]) {
      state.players[socket.id].score = score;
      // Broadcast live ranking to admin + all
      io.emit('live_ranking', getRanking());
    }
  });

  // ── Player finished (game over) ──
  socket.on('player_game_over', ({ score, name }) => {
    if (state.players[socket.id]) {
      state.players[socket.id].score = score;
    }
    io.emit('live_ranking', getRanking());
  });

  // ── Admin ends game manually ──
  socket.on('admin_end_game', () => {
    if (!state.gameActive) return;
    state.gameActive = false;
    const ranking = getRanking();
    if (state.currentGame !== null) {
      state.scores.push({
        game: GAMES[state.currentGame].name,
        ts: new Date().toISOString(),
        ranking,
      });
    }
    io.emit('game_end', { ranking, game: state.currentGame !== null ? GAMES[state.currentGame] : null });
    broadcastState();
    console.log('🛑 Game ended by admin');
  });

  // ── Admin resets room ──
  socket.on('admin_reset', () => {
    state.gameActive = false;
    state.currentGame = null;
    Object.keys(state.players).forEach(id => { state.players[id].score = 0; });
    io.emit('room_reset');
    broadcastState();
    console.log('🔄 Room reset');
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      console.log(`👋 Player left: ${state.players[socket.id].name}`);
      delete state.players[socket.id];
      broadcastState();
    }
  });
});

// ─── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Retro Arcade running on port ${PORT}`);
});
