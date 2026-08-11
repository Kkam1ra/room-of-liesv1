const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const ROLES = ['Gangster','Gangster','Police','Reporter','Neutral Citizen','Normal Citizen','Normal Citizen','Normal Citizen','Normal Citizen'];
const INVESTIGATION_TIME = 27 * 60 * 1000;
const DISCUSSION_TIME = 3 * 60 * 1000;
const POLICE_DECISION_TIME = 30 * 1000; // 30s for police to choose
const MAX_ROUNDS = 5;
const BOT_NAMES = ['Alex','Sam','Jordan','Casey','Riley','Taylor','Morgan','Blake'];

function generateCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

function createBot() {
  return { id: 'bot'+Date.now()+Math.random(), name: BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)] + Math.floor(Math.random()*10), role: null, number: Math.floor(Math.random()*100), agenda: null, team: null, alive: true, isBot: true, hasVoted: false }
}

function generateClue(room) {
  const allPlayers = [...room.players,...room.bots].filter(p=>p.alive);
  const clueTypes = [
    () => { const nums = allPlayers.map(p=>p.number).sort((a,b)=>a-b); return `Clue: Player numbers range from ${nums[0]} to ${nums[nums.length-1]}`; },
    () => { const gangsters = allPlayers.filter(p=>p.role==='Gangster').length; return `Clue: There are ${gangsters} Gangsters still alive`; },
    () => { const mostActiveId = Object.keys(room.messageCount).reduce((a,b)=> room.messageCount[a] > room.messageCount[b]? a : b, null); const name = mostActiveId? getName(mostActiveId, room.code) : 'Someone'; return `Clue: ${name} sent the most messages this round`; },
    () => { const sum = allPlayers.reduce((acc,p)=>acc+p.number,0); return `Clue: The sum of all player numbers is ${sum}`; },
  ];
  return clueTypes[Math.floor(Math.random()*clueTypes.length)]();
}

function getName(id, code) {
  const p = [...rooms[code].players,...rooms[code].bots].find(x=>x.id===id);
  return p? p.name : 'Unknown';
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({playerName, isPrivate}) => {
    const code = generateCode();
    rooms[code] = {
      players: [{id: socket.id, name: playerName, role: null, number: null, agenda: null, team: null, alive: true, hasVoted: false}],
      bots: [], state: 'countdown', isPrivate, countdown: 60, round: 0, phase: 'lobby', code,
      votes: {}, gangsterKillVotes: {}, policeVote: null, roundEvents: [], messageCount: {}, alliances: {},
      earlyVoteRequests: new Set()
    };
    socket.join(code);
    socket.emit('roomCreated', {code, directJoin:!isPrivate});
    io.emit('publicRoomList', getPublicRooms());
    startCountdown(code);
  });

  socket.on('joinPublicRoom', ({code, playerName}) => {
    if(rooms[code] &&!rooms[code].isPrivate && rooms[code].state === 'countdown') {
      rooms[code].players.push({id: socket.id, name: playerName, role: null, number: null, agenda: null, team: null, alive: true, hasVoted: false});
      socket.join(code);
      socket.emit('roomCreated', {code, directJoin: true});
      io.to(code).emit('playerList', getPlayerList(code));
    }
  });

  socket.on('joinRoom', ({code, playerName}) => {
    if(rooms[code] && rooms[code].state === 'countdown') {
      rooms[code].players.push({id: socket.id, name: playerName, role: null, number: null, agenda: null, team: null, alive: true, hasVoted: false});
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
    while(rooms[code].players.length + rooms[code].bots.length < 9) {
      rooms[code].bots.push(createBot());
    }
  }

  function startGame(code) {
    const room = rooms[code];
    room.state = 'playing'; room.round = 1; room.phase = 'investigation';
    io.emit('publicRoomList', getPublicRooms());

    const allPlayers = [...room.players,...room.bots];
    const shuffledRoles = shuffle(ROLES).slice(0, allPlayers.length);

    allPlayers.forEach((p, i) => {
      p.role = shuffledRoles[i];
      p.number = Math.floor(Math.random() * 100);
      p.agenda = generateAgenda(p.role);
      if(p.role === 'Neutral Citizen') p.team = Math.random() < 0.5? 'Gangster' : 'Police';
      if(!p.isBot) {
        const payload = {role: p.role, number: p.number, agenda: p.agenda};
        if(p.role === 'Neutral Citizen') payload.team = p.team;
        io.to(p.id).emit('roleAssigned', payload);
      }
    });

    io.to(code).emit('playerList', getPlayerList(code));
    startInvestigation(code);
    runBotAI(code);
  }

  function generateAgenda(role) {
    const agendas = {
      'Gangster': ['Kill 4 citizens', 'Frame the Reporter', 'Survive to round 3'],
      'Police': ['Choose the right person to eliminate', 'Find both Gangsters', 'Survive'],
      'Reporter': ['Investigate 2 people', 'Expose a Gangster', 'Stay alive'],
      'Neutral Citizen': ['Help your secret team win'],
      'Normal Citizen': ['Survive', 'Vote correctly', 'Find the Gangsters'],
    };
    const list = agendas[role] || ['Survive'];
    return list[Math.floor(Math.random() * list.length)];
  }

  function startInvestigation(code) {
    const room = rooms[code];
    if(room.round > MAX_ROUNDS || checkWin(code)) return endGame(code);

    room.phase = 'investigation';
    room.votes = {};
    room.gangsterKillVotes = {};
    room.policeVote = null;
    room.roundEvents = [];
    room.messageCount = {};
    room.earlyVoteRequests = new Set();
    [...room.players,...room.bots].forEach(p=>p.hasVoted = false);
    room.clue = generateClue(room);

    io.to(code).emit('phaseChange', {phase: 'investigation', time: INVESTIGATION_TIME});
    io.to(code).emit('roundStart', {round: room.round, total: MAX_ROUNDS, clue: room.clue});
    io.to(code).emit('playerList', getPlayerList(code));

    const gangsters = room.players.filter(p => p.role === 'Gangster' && p.alive);
    gangsters.forEach(g => socket.adapter.remoteJoin(g.id, `gangsters-${code}`));

    room.investigationTimeout = setTimeout(() => startDiscussion(code), INVESTIGATION_TIME);
  }

  function startDiscussion(code) {
    const room = rooms[code];
    room.phase = 'discussion';
    io.to(code).emit('phaseChange', {phase: 'discussion', time: DISCUSSION_TIME});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- FINAL DISCUSSION: 3 MINUTES TO VOTE ---'});

    setTimeout(() => startVoting(code), DISCUSSION_TIME);
  }

  // VOTING -> THEN POLICE CHOOSES
  function startVoting(code) {
    const room = rooms[code];
    room.phase = 'voting';
    io.to(code).emit('phaseChange', {phase: 'voting', time: 60000});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- VOTING NOW. 1 VOTE PER PERSON ---'});

    setTimeout(() => policeDecisionPhase(code), 60000);
  }

  // NEW: POLICE DECIDES WHO DIES
  function policeDecisionPhase(code) {
    const room = rooms[code];
    room.phase = 'police';
    const police = [...room.players,...room.bots].find(p=>p.role==='Police' && p.alive);

    io.to(code).emit('phaseChange', {phase: 'police', time: POLICE_DECISION_TIME});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- POLICE IS DECIDING WHO TO ELIMINATE ---'});
    io.to(code).emit('voteResults', room.votes); // show who got most votes

    if(police &&!police.isBot) {
      io.to(police.id).emit('policeDecision', {votes: room.votes}); // only police sees this
    } else if(police && police.isBot) {
      // Bot police picks most voted
      setTimeout(() => {
        const mostVotedId = Object.keys(room.votes).reduce((a,b)=> room.votes[a] > room.votes[b]? a : b, null);
        room.policeVote = mostVotedId;
        endRound(code);
      }, 5000);
    }

    setTimeout(() => { if(!room.policeVote) room.policeVote = Object.keys(room.votes)[0]; endRound(code); }, POLICE_DECISION_TIME);
  }

  socket.on('policeChoose', ({code, targetId}) => {
    const room = rooms[code];
    if(room.phase!== 'police') return;
    const police = [...room.players,...room.bots].find(p=>p.id===socket.id);
    if(police.role!== 'Police') return;
    room.policeVote = targetId;
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: `Police has made their decision`});
    endRound(code);
  });

  socket.on('requestEarlyVote', ({code}) => {
    const room = rooms[code];
    if(room.phase!== 'investigation') return;
    room.earlyVoteRequests.add(socket.id);
    const aliveCount = getPlayerList(code).length;
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: `${getName(socket.id, code)} wants to vote early. ${room.earlyVoteRequests.size}/${aliveCount}`});

    if(room.earlyVoteRequests.size >= aliveCount) {
      io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: 'Everyone agreed. Starting discussion early!'});
      clearTimeout(room.investigationTimeout);
      startDiscussion(code);
    }
  });

  function runBotAI(code) {
    const interval = setInterval(() => {
      const room = rooms[code];
      if(!room || room.state!== 'playing') return clearInterval(interval);

      const alivePlayers = getPlayerList(code);
      const humanCount = alivePlayers.filter(p=>!p.isBot).length;

      room.bots.forEach(bot => {
        if(!bot.alive || bot.hasVoted) return;

        if(room.phase === 'investigation' && Math.random() < 0.15) {
          const msgs = [`my number is ${bot.number}`, "anyone got clues?", "checking numbers"];
          io.to(code).emit('publicMsg', {from: bot.name, msg: msgs[Math.floor(Math.random()*msgs.length)]});
        }

        if(room.phase === 'discussion' && Math.random() < 0.25) {
          const susTarget = pickSuspect(room, alivePlayers);
          const msgs = ["sus", susTarget? `${susTarget.name} is sus` : "idk", "vote him"];
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

  function endRound(code) {
    processRoundActions(code);
    rooms[code].round++;
    startInvestigation(code);
  }

  // FIX: ONLY POLICE CHOICE MATTERS
  function processRoundActions(code) {
    const room = rooms[code];
    const allPlayers = [...room.players,...room.bots];

    // Gangster kill first
    const killTargetId = Object.keys(room.gangsterKillVotes).reduce((a,b)=> room.gangsterKillVotes[a] > room.gangsterKillVotes[b]? a : b, null);
    if(killTargetId) {
      const killed = allPlayers.find(p=>p.id===killTargetId);
      if(killed) {
        killed.alive = false;
        io.to(code).emit('elimination', {type: 'gangster kill', name: killed.name, role: killed.role});
      }
    }

    // Police chooses who dies from votes
    if(room.policeVote) {
      const voted = allPlayers.find(p=>p.id===room.policeVote);
      if(voted && voted.alive) {
        voted.alive = false;
        io.to(code).emit('elimination', {type: 'police elimination', name: voted.name, role: voted.role});
      }
    }
  }

  function checkWin(code) {
    const room = rooms[code];
    const alive = [...room.players,...room.bots].filter(p => p.alive);
    const aliveGangsters = alive.filter(p => p.role === 'Gangster');
    const aliveNeutrals = alive.filter(p => p.role === 'Neutral Citizen');
    const gangsterTeamAlive = aliveGangsters.length + aliveNeutrals.filter(n=>n.team==='Gangster').length;
    const policeTeamAlive = alive.filter(p=>p.role!=='Gangster' && (p.role!=='Neutral Citizen' || p.team==='Police')).length;

    if(aliveGangsters.length === 0 && aliveNeutrals.filter(n=>n.team==='Gangster').length === 0) return 'citizens';
    if(gangsterTeamAlive >= policeTeamAlive) return 'gangsters';
    if(room.round >= MAX_ROUNDS && aliveGangsters.length > 0) return 'gangsters';
    return false;
  }

  function endGame(code) {
    const winner = checkWin(code);
    io.to(code).emit('gameOver', {winner, message: winner === 'gangsters'? 'Gangsters + Neutral Win!' : 'Police + Citizens + Neutral Win!'});
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Room of Lies v1.9 on port ${PORT}`)); 
  
