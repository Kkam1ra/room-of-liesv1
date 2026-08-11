const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const ROLES = ['Gangster','Gangster','Police','Reporter','Neutral Citizen','Normal Citizen','Citizen Type 1','Citizen Type 2','Citizen Type 3'];
const ROUND_TIME = 30 * 60 * 1000; // 30 min
const MAX_ROUNDS = 5;
const BOT_NAMES = ['Alex','Sam','Jordan','Casey','Riley','Taylor','Morgan','Blake'];

function generateCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

function createBot() {
  return {
    id: 'bot'+Date.now()+Math.random(),
    name: BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)] + Math.floor(Math.random()*10),
    role: null,
    number: Math.floor(Math.random()*100),
    agenda: null,
    alive: true
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({playerName, isPrivate}) => {
    const code = generateCode();
    rooms[code] = {
      players: [{id: socket.id, name: playerName, role: null, number: null, agenda: null, alive: true}],
      bots: [],
      state: 'countdown',
      isPrivate,
      countdown: 60,
      round: 0,
      votes: {},
      gangsterKillVotes: {},
      roundEvents: [],
      messageCount: {}
    };
    socket.join(code);
    socket.emit('roomCreated', code);
    io.emit('publicRoomList', getPublicRooms()); // update everyone
    startCountdown(code);
  });

  socket.on('joinRoom', ({code, playerName}) => {
    if(rooms[code] && rooms[code].state === 'countdown') {
      rooms[code].players.push({id: socket.id, name: playerName, role: null, number: null, agenda: null, alive: true});
      socket.join(code);
      io.to(code).emit('playerList', getPlayerList(code));
    }
  });

  socket.on('getPublicRooms', () => {
    socket.emit('publicRoomList', getPublicRooms());
  });

  function getPublicRooms() {
    return Object.keys(rooms)
     .filter(code =>!rooms[code].isPrivate && rooms[code].state === 'countdown')
     .map(code => ({code, players: rooms[code].players.length + rooms[code].bots.length}));
  }

  socket.on('addBot', (code) => {
    if(rooms[code] && rooms[code].state === 'countdown') {
      rooms[code].bots.push(createBot());
      io.to(code).emit('playerList', getPlayerList(code));
    }
  });

  function getPlayerList(code) {
    const room = rooms[code];
    return [...room.players,...room.bots].filter(p=>p.alive).map(p=>({id:p.id, name:p.name}));
  }

  function startCountdown(code) {
    const interval = setInterval(() => {
      rooms[code].countdown--;
      io.to(code).emit('countdown', rooms[code].countdown);
      if(rooms[code].countdown <= 0) {
        clearInterval(interval);
        fillWithBots(code);
        startGame(code);
      }
    }, 1000);
  }

  function fillWithBots(code) {
    while(rooms[code].players.length + rooms[code].bots.length < 7) {
      rooms[code].bots.push(createBot());
    }
  }

  function startGame(code) {
    const room = rooms[code];
    room.state = 'playing';
    room.round = 1;
    io.emit('publicRoomList', getPublicRooms()); // remove from list

    const allPlayers = [...room.players,...room.bots];
    const shuffledRoles = shuffle(ROLES).slice(0, allPlayers.length);

    allPlayers.forEach((p, i) => {
      p.role = shuffledRoles[i];
      p.number = Math.floor(Math.random() * 100);
      p.agenda = generateAgenda(p.role);
      if(!p.id.startsWith('bot')) io.to(p.id).emit('roleAssigned', {role: p.role, number: p.number, agenda: p.agenda});
    });

    io.to(code).emit('playerList', getPlayerList(code));
    startRound(code);
  }

  function generateAgenda(role) {
    const agendas = {
      'Gangster': ['Frame someone', 'Survive all rounds', 'Get 1 citizen eliminated'],
      'Police': ['Catch a gangster', 'Protect the Reporter', 'Survive to round 3'],
      'Reporter': ['Investigate 2 people', 'Stay alive', 'Expose a gangster'],
      'Neutral Citizen': ['Help Police win', 'Help Gangsters win'],
      'Normal Citizen': ['Survive', 'Vote correctly 3 times']
    };
    const list = agendas[role] || ['Survive'];
    return list[Math.floor(Math.random() * list.length)];
  }

  function startRound(code) {
    const room = rooms[code];
    if(room.round > MAX_ROUNDS || checkWin(code)) return endGame(code);

    room.votes = {};
    room.gangsterKillVotes = {};
    room.roundEvents = [];
    room.messageCount = {};
    room.clue = generateClue(room);

    io.to(code).emit('roundStart', {round: room.round, total: MAX_ROUNDS, clue: room.clue, time: ROUND_TIME});
    io.to(code).emit('playerList', getPlayerList(code));

    const gangsters = room.players.filter(p => p.role === 'Gangster' && p.alive);
    gangsters.forEach(g => socket.adapter.remoteJoin(g.id, `gangsters-${code}`));

    setTimeout(() => endRound(code), ROUND_TIME);
  }

  function generateClue(room) {
    const clueTypes = [
      {type: 'pattern', text: `Pattern: 2, 4, 8, 16,? The answer matches a player's number`},
      {type: 'math', text: `Clue: Target's number is a prime number between 20 and 40`},
      {type: 'behavior', text: `Clue: The target has not spoken in public chat this round`},
      {type: 'behavior', text: `Clue: The target voted for 2 different people last round`},
      {type: 'event', text: `Clue: Look at who defended themselves the most in chat`},
      {type: 'vague', text: `Clue: Trust is dangerous this round`}
    ];
    return clueTypes[Math.floor(Math.random()*clueTypes.length)];
  }

  socket.on('publicMessage', ({code, msg}) => {
    if(rooms[code]) {
      rooms[code].roundEvents.push({type: 'message', from: socket.id});
      rooms[code].messageCount[socket.id] = (rooms[code].messageCount[socket.id] || 0) + 1;
    }
    io.to(code).emit('publicMsg', {from: getName(socket.id, code), msg});
  });

  socket.on('gangsterMessage', ({code, msg}) => {
    io.to(`gangsters-${code}`).emit('gangsterMsg', {from: getName(socket.id, code), msg});
  });

  socket.on('createAlliance', ({code, playerIds}) => {
    const allianceId = `alliance-${Date.now()}`;
    playerIds.forEach(id=>io.sockets.sockets.get(id)?.join(allianceId));
    io.to(allianceId).emit('systemMsg', 'Alliance chat created');
  });

  socket.on('allianceMessage', ({allianceId, msg}) => {
    io.to(allianceId).emit('allianceMsg', {from: socket.id, msg});
  });

  socket.on('publicVote', ({code, targetId}) => {
    const room = rooms[code];
    if(!room) return;
    room.votes[targetId] = (room.votes[targetId] || 0) + 1;
    room.roundEvents.push({type: 'vote', from: socket.id, target: targetId});
    io.to(code).emit('voteUpdate', room.votes);
  });

  socket.on('gangsterVoteKill', ({code, targetId}) => {
    const room = rooms[code];
    room.gangsterKillVotes[targetId] = (room.gangsterKillVotes[targetId] || 0) + 1;
  });

  socket.on('reporterInvestigate', ({code, targetId}) => {
    const room = rooms[code];
    const target = [...room.players,...room.bots].find(p=>p.id===targetId);
    const result = target.role === 'Gangster'? 'Gangster' : 'Not Gangster';
    socket.emit('investigationResult', {target: target.name, result});
  });

  function getName(id, code) {
    const p = [...rooms[code].players,...rooms[code].bots].find(x=>x.id===id);
    return p? p.name : 'Unknown';
  }

  function endRound(code) {
    processRoundActions(code);
    rooms[code].round++;
    startRound(code);
  }

  function processRoundActions(code) {
    const room = rooms[code];
    const allPlayers = [...room.players,...room.bots];

    const killTargetId = Object.keys(room.gangsterKillVotes).reduce((a,b)=> room.gangsterKillVotes[a] > room.gangsterKillVotes[b]? a : b, null);
    if(killTargetId) {
      const killed = allPlayers.find(p=>p.id===killTargetId);
      if(killed) killed.alive = false;
      io.to(code).emit('elimination', {type: 'gangster kill', name: killed.name});
    }

    const voteTargetId = Object.keys(room.votes).reduce((a,b)=> room.votes[a] > room.votes[b]? a : b, null);
    if(voteTargetId) {
      const voted = allPlayers.find(p=>p.id===voteTargetId);
      if(voted) voted.alive = false;
      io.to(code).emit('elimination', {type: 'vote', name: voted.name});
    }
  }

  function checkWin(code) {
    const room = rooms[code];
    const alive = [...room.players,...room.bots].filter(p => p.alive);
    const aliveGangsters = alive.filter(p => p.role === 'Gangster');
    const aliveCitizens = alive.filter(p => p.role!== 'Gangster');
    if(aliveGangsters.length === 0) return 'citizens';
    if(aliveGangsters.length >= aliveCitizens.length) return 'gangsters';
    if(room.round >= MAX_ROUNDS && aliveGangsters.length > 0) return 'gangsters';
    return false;
  }

  function endGame(code) {
    const winner = checkWin(code);
    io.to(code).emit('gameOver', {winner, message: winner === 'gangsters'? 'Gangsters Win!' : 'Citizens Win!'});
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Room of Lies running on port ${PORT}`));
