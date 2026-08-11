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
const DISCUSSION_TIME = 28 * 60 * 1000; // 28 min
const VOTING_TIME = 2 * 60 * 1000; // 2 min
const MAX_ROUNDS = 5;
const BOT_NAMES = ['Alex','Sam','Jordan','Casey','Riley','Taylor','Morgan','Blake'];

function generateCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

function createBot() {
  return { id: 'bot'+Date.now()+Math.random(), name: BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)] + Math.floor(Math.random()*10), role: null, number: Math.floor(Math.random()*100), agenda: null, alive: true, isBot: true, hasVoted: false }
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({playerName, isPrivate}) => {
    const code = generateCode();
    rooms[code] = {
      players: [{id: socket.id, name: playerName, role: null, number: null, agenda: null, alive: true, hasVoted: false}],
      bots: [], state: 'countdown', isPrivate, countdown: 60, round: 0, phase: 'lobby',
      votes: {}, gangsterKillVotes: {}, roundEvents: [], messageCount: {}, alliances: {}
    };
    socket.join(code);
    socket.emit('roomCreated', {code, directJoin:!isPrivate});
    io.emit('publicRoomList', getPublicRooms());
    startCountdown(code);
  });

  socket.on('joinPublicRoom', ({code, playerName}) => {
    if(rooms[code] &&!rooms[code].isPrivate && rooms[code].state === 'countdown') {
      rooms[code].players.push({id: socket.id, name: playerName, role: null, number: null, agenda: null, alive: true, hasVoted: false});
      socket.join(code);
      socket.emit('roomCreated', {code, directJoin: true});
      io.to(code).emit('playerList', getPlayerList(code));
    }
  });

  socket.on('joinRoom', ({code, playerName}) => {
    if(rooms[code] && rooms[code].state === 'countdown') {
      rooms[code].players.push({id: socket.id, name: playerName, role: null, number: null, agenda: null, alive: true, hasVoted: false});
      socket.join(code);
      io.to(code).emit('playerList', getPlayerList(code));
    }
  });

  socket.on('getPublicRooms', () => socket.emit('publicRoomList', getPublicRooms()));
  function getPublicRooms() {
    return Object.keys(rooms).filter(code =>!rooms[code].isPrivate && rooms[code].state === 'countdown').map(code => ({code, players: rooms[code].players.length + rooms[code].bots.length}));
  }

  socket.on('addBot', (code) => {
    if(rooms[code] && rooms[code].state === 'countdown') {
      rooms[code].bots.push(createBot());
      io.to(code).emit('playerList', getPlayerList(code));
    }
  });

  function getPlayerList(code) {
    const room = rooms[code];
    return [...room.players,...room.bots].filter(p=>p.alive).map(p=>({id:p.id, name:p.name, isBot:p.isBot, hasVoted:p.hasVoted}));
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
    room.state = 'playing'; room.round = 1; room.phase = 'discussion';
    io.emit('publicRoomList', getPublicRooms());

    const allPlayers = [...room.players,...room.bots];
    const shuffledRoles = shuffle(ROLES).slice(0, allPlayers.length);

    allPlayers.forEach((p, i) => {
      p.role = shuffledRoles[i];
      p.number = Math.floor(Math.random() * 100);
      p.agenda = generateAgenda(p.role);
      p.hasVoted = false;
      if(!p.isBot) io.to(p.id).emit('roleAssigned', {role: p.role, number: p.number, agenda: p.agenda});
    });

    io.to(code).emit('playerList', getPlayerList(code));
    startDiscussion(code);
    runBotAI(code);
  }

  function generateAgenda(role) {
    const agendas = {
      'Gangster': ['Frame someone', 'Survive all rounds', 'Get 1 citizen eliminated'],
      'Police': ['Catch a gangster', 'Protect the Reporter', 'Survive to round 3'],
      'Reporter': ['Investigate 2 people', 'Stay alive', 'Expose a gangster'],
    };
    const list = agendas[role] || ['Survive'];
    return list[Math.floor(Math.random() * list.length)];
  }

  function startDiscussion(code) {
    const room = rooms[code];
    if(room.round > MAX_ROUNDS || checkWin(code)) return endGame(code);

    room.phase = 'discussion';
    room.votes = {};
    room.gangsterKillVotes = {};
    room.roundEvents = [];
    room.messageCount = {};
    [...room.players,...room.bots].forEach(p=>p.hasVoted = false);
    room.clue = {type: 'random', text: `Clue: ${['Someone is lying','Watch chat activity','Numbers matter this round'][Math.floor(Math.random()*3)]}`};

    io.to(code).emit('phaseChange', {phase: 'discussion', time: DISCUSSION_TIME});
    io.to(code).emit('roundStart', {round: room.round, total: MAX_ROUNDS, clue: room.clue});
    io.to(code).emit('playerList', getPlayerList(code));

    const gangsters = room.players.filter(p => p.role === 'Gangster' && p.alive);
    gangsters.forEach(g => socket.adapter.remoteJoin(g.id, `gangsters-${code}`));

    setTimeout(() => startVoting(code), DISCUSSION_TIME);
  }

  function startVoting(code) {
    const room = rooms[code];
    room.phase = 'voting';
    io.to(code).emit('phaseChange', {phase: 'voting', time: VOTING_TIME});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- VOTING STARTED. 1 VOTE PER PERSON ---'});

    setTimeout(() => endRound(code), VOTING_TIME);
  }

  function runBotAI(code) {
    const interval = setInterval(() => {
      const room = rooms[code];
      if(!room || room.state!== 'playing') return clearInterval(interval);

      const alivePlayers = getPlayerList(code);
      const humanCount = alivePlayers.filter(p=>!p.isBot).length;

      room.bots.forEach(bot => {
        if(!bot.alive || bot.hasVoted) return;

        if(room.phase === 'discussion' && Math.random() < 0.2) {
          const susTarget = pickSuspect(room, alivePlayers);
          const msgs = ["sus", "idk", susTarget? `i think ${susTarget.name} is sus` : "chill", "vote him"];
          io.to(code).emit('publicMsg', {from: bot.name, msg: msgs[Math.floor(Math.random()*msgs.length)]});
        }

        if(room.phase === 'voting') {
          const voteChance = humanCount <= 2? 0.9 : 0.6;
          if(Math.random() < voteChance) {
            const target = pickSuspect(room, alivePlayers);
            if(target && target.id!== bot.id) {
              room.votes[target.id] = (room.votes[target.id] || 0) + 1;
              bot.hasVoted = true;
              io.to(code).emit('voteUpdate', room.votes);
              io.to(code).emit('publicMsg', {from: bot.name, msg: `voting ${target.name}`});
            }
          }
        }
      });
    }, 8000);
  }

  function pickSuspect(room, alivePlayers) {
    const quiet = alivePlayers.filter(p => (room.messageCount[p.id] || 0) === 0);
    if(quiet.length > 0) return quiet[Math.floor(Math.random()*quiet.length)];
    const mostVotedId = Object.keys(room.votes).reduce((a,b)=> room.votes[a] > room.votes[b]? a : b, null);
    if(mostVotedId) return alivePlayers.find(p=>p.id === mostVotedId);
    return alivePlayers[Math.floor(Math.random()*alivePlayers.length)];
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
    rooms[code].alliances[allianceId] = playerIds;
    playerIds.forEach(id=>io.sockets.sockets.get(id)?.join(allianceId));
    io.to(allianceId).emit('systemMsg', 'Alliance chat created');
    io.to(allianceId).emit('allianceCreated', allianceId);
  });

  socket.on('allianceMessage', ({allianceId, msg, code}) => {
    io.to(allianceId).emit('allianceMsg', {from: getName(socket.id, code), msg});
  });

  socket.on('publicVote', ({code, targetId}) => {
    const room = rooms[code];
    if(!room || room.phase!== 'voting') return;
    const player = [...room.players,...room.bots].find(p=>p.id === socket.id);
    if(player.hasVoted) return socket.emit('systemMsg', 'You already voted this round');

    player.hasVoted = true;
    room.votes[targetId] = (room.votes[targetId] || 0) + 1;
    io.to(code).emit('voteUpdate', room.votes);
    io.to(code).emit('playerList', getPlayerList(code));
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
    startDiscussion(code);
  }

  // ROLE REVEAL ON DEATH
  function processRoundActions(code) {
    const room = rooms[code];
    const allPlayers = [...room.players,...room.bots];

    const killTargetId = Object.keys(room.gangsterKillVotes).reduce((a,b)=> room.gangsterKillVotes[a] > room.gangsterKillVotes[b]? a : b, null);
    if(killTargetId) {
      const killed = allPlayers.find(p=>p.id===killTargetId);
      if(killed) {
        killed.alive = false;
        io.to(code).emit('elimination', {type: 'gangster kill', name: killed.name, role: killed.role});
      }
    }

    const voteTargetId = Object.keys(room.votes).reduce((a,b)=> room.votes[a] > room.votes[b]? a : b, null);
    if(voteTargetId) {
      const voted = allPlayers.find(p=>p.id===voteTargetId);
      if(voted) {
        voted.alive = false;
        io.to(code).emit('elimination', {type: 'vote', name: voted.name, role: voted.role});
      }
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
server.listen(PORT, () => console.log(`Room of Lies v1.5 on port ${PORT}`)); 
