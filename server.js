const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const INVESTIGATION_TIME = 27 * 60 * 1000;
const DISCUSSION_TIME = 3 * 60 * 1000;
const POLICE_DECISION_TIME = 30 * 1000;
const MAX_ROUNDS = 5;
const MIN_PLAYERS = 7;
const BOT_NAMES = ['Alex','Sam','Jordan','Casey','Riley','Taylor','Morgan','Blake'];

function generateCode() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

function createBot() {
  return { id: 'bot'+Date.now()+Math.random(), name: BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)] + Math.floor(Math.random()*100), role: null, number: Math.floor(Math.random()*100), agenda: null, team: null, alive: true, isBot: true, hasVoted: false, personality: Math.random() }
}

function getRolesForPlayerCount(count) {
  const roles = [];
  roles.push('Police');
  roles.push('Reporter');
  roles.push('Neutral Citizen');
  const gangsterCount = Math.max(2, Math.floor(count / 4));
  for(let i = 0; i < gangsterCount; i++) roles.push('Gangster');
  const remaining = count - roles.length;
  for(let i = 0; i < remaining; i++) roles.push('Normal Citizen');
  return roles;
}

function getName(id, code) {
  if(!rooms[code]) return 'Unknown';
  const p = [...rooms[code].players,...rooms[code].bots].find(x=>x.id===id);
  return p? p.name : 'Unknown';
}

function generateClue(room) {
  try {
    const allPlayers = [...room.players,...room.bots].filter(p=>p.alive);
    if(allPlayers.length === 0) return "Clue: No players alive";
    const clueTypes = [
      () => { const nums = allPlayers.map(p=>p.number).sort((a,b)=>a-b); return `Clue: Player numbers range from ${nums[0]} to ${nums[nums.length-1]}`; },
      () => { const gangsters = allPlayers.filter(p=>p.role==='Gangster').length; return `Clue: There are ${gangsters} Gangsters still alive`; },
      () => {
        const entries = Object.entries(room.messageCount);
        if(entries.length === 0) return "Clue: No one has talked yet";
        const mostActiveId = entries.reduce((a,b)=> room.messageCount[a[0]] > room.messageCount[b[0]]? a : b)[0];
        const name = getName(mostActiveId, room.code);
        return `Clue: ${name} sent the most messages this round`;
      },
      () => { const sum = allPlayers.reduce((acc,p)=>acc+p.number,0); return `Clue: The sum of all player numbers is ${sum}`; },
    ];
    return clueTypes[Math.floor(Math.random()*clueTypes.length)]();
  } catch(e) { return "Clue: Something happened this round"; }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({playerName, isPrivate}) => {
    const code = generateCode();
    rooms[code] = {
      players: [{id: socket.id, name: playerName, role: null, number: null, agenda: null, team: null, alive: true, hasVoted: false}],
      bots: [], state: 'countdown', isPrivate, countdown: 60, round: 0, phase: 'lobby', code,
      votes: {}, gangsterKillVotes: {}, policeVote: null, roundEvents: [], messageCount: {}, alliances: {},
      earlyVoteRequests: new Set(), investigationTimeout: null
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
    if(!rooms[code]) return [];
    const room = rooms[code];
    return [...room.players,...room.bots].filter(p=>p.alive).map(p=>({id:p.id, name:p.name, isBot:p.isBot, hasVoted:p.hasVoted}));
  }

  function startCountdown(code) {
    const interval = setInterval(() => {
      if(!rooms[code]) return clearInterval(interval);
      rooms[code].countdown--;
      io.to(code).emit('countdown', rooms[code].countdown);
      if(rooms[code].countdown <= 0) {
        clearInterval(interval);
        const total = rooms[code].players.length + rooms[code].bots.length;
        if(total < MIN_PLAYERS) {
          while(rooms[code].players.length + rooms[code].bots.length < MIN_PLAYERS) {
            rooms[code].bots.push(createBot());
          }
        }
        startGame(code);
      }
    }, 1000);
  }

  function startGame(code) {
    if(!rooms[code]) return;
    const room = rooms[code];
    room.state = 'playing'; room.round = 1; room.phase = 'investigation';
    io.emit('publicRoomList', getPublicRooms());

    const allPlayers = [...room.players,...room.bots];
    const roleList = getRolesForPlayerCount(allPlayers.length);
    const shuffledRoles = shuffle(roleList);

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
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: `Game starting with ${allPlayers.length} players`});
    startInvestigation(code);
    runBotAI(code);
  }

  function generateAgenda(role) {
    const agendas = {
      'Gangster': ['Kill citizens', 'Frame the Reporter', 'Survive to round 3'],
      'Police': ['Choose the right person to eliminate', 'Find all Gangsters', 'Survive'],
      'Reporter': ['Investigate people', 'Expose a Gangster', 'Stay alive'],
      'Neutral Citizen': ['Help your secret team win'],
      'Normal Citizen': ['Survive', 'Vote correctly', 'Find the Gangsters'],
    };
    const list = agendas[role] || ['Survive'];
    return list[Math.floor(Math.random() * list.length)];
  }

  function startInvestigation(code) {
    if(!rooms[code]) return;
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
    if(!rooms[code]) return;
    const room = rooms[code];
    room.phase = 'discussion';
    io.to(code).emit('phaseChange', {phase: 'discussion', time: DISCUSSION_TIME});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- FINAL DISCUSSION: 3 MINUTES TO VOTE ---'});
    setTimeout(() => startVoting(code), DISCUSSION_TIME);
  }

  function startVoting(code) {
    if(!rooms[code]) return;
    const room = rooms[code];
    room.phase = 'voting';
    io.to(code).emit('phaseChange', {phase: 'voting', time: 60000});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- VOTING NOW. 1 VOTE PER PERSON ---'});
    setTimeout(() => policeDecisionPhase(code), 60000);
  }

  function policeDecisionPhase(code) {
    if(!rooms[code]) return;
    const room = rooms[code];
    room.phase = 'police';
    const police = [...room.players,...room.bots].find(p=>p.role==='Police' && p.alive);

    io.to(code).emit('phaseChange', {phase: 'police', time: POLICE_DECISION_TIME});
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: '--- POLICE IS DECIDING WHO TO ELIMINATE ---'});
    io.to(code).emit('voteResults', room.votes);

    if(police &&!police.isBot) {
      io.to(police.id).emit('policeDecision', {votes: room.votes});
    } else if(police && police.isBot) {
      setTimeout(() => {
        const entries = Object.entries(room.votes);
        room.policeVote = entries.length > 0? entries.reduce((a,b)=> room.votes[a[0]] > room.votes[b[0]]? a : b)[0] : null;
        endRound(code);
      }, 5000);
    }

    setTimeout(() => {
      if(!room.policeVote) {
        const entries = Object.entries(room.votes);
        room.policeVote = entries.length > 0? entries[0][0] : null;
      }
      endRound(code);
    }, POLICE_DECISION_TIME);
  }

  socket.on('policeChoose', ({code, targetId}) => {
    if(!rooms[code]) return;
    const room = rooms[code];
    if(room.phase!== 'police') return;
    const police = [...room.players,...room.bots].find(p=>p.id===socket.id);
    if(police.role!== 'Police') return;
    room.policeVote = targetId;
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: `Police has made their decision`});
    endRound(code);
  });

  socket.on('requestEarlyVote', ({code}) => {
    if(!rooms[code]) return;
    const room = rooms[code];
    if(room.phase!== 'investigation') return;
    room.earlyVoteRequests.add(socket.id);
    const aliveCount = getPlayerList(code).length;
    io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: `${getName(socket.id, code)} wants to vote early. ${room.earlyVoteRequests.size}/${aliveCount}`});
    if(room.earlyVoteRequests.size >= aliveCount) {
      io.to(code).emit('publicMsg', {from: 'SYSTEM', msg: 'Everyone agreed. Starting discussion early!'});
      if(room.investigationTimeout) clearTimeout(room.investigationTimeout);
      startDiscussion(code);
    }
  });

  // SMART BOT AI v1.9.5
  function runBotAI(code) {
    const interval = setInterval(() => {
      if(!rooms[code] || rooms[code].state!== 'playing') return clearInterval(interval);
      const room = rooms[code];
      const allPlayers = [...room.players,...room.bots];

      room.bots.forEach(bot => {
        if(!bot.alive || bot.hasVoted) return;

        if(bot.role === 'Gangster') {
          gangsterBotLogic(bot, room, allPlayers);
        } else if(bot.role === 'Reporter') {
          reporterBotLogic(bot, room, allPlayers);
        } else if(bot.role === 'Police') {
          policeBotLogic(bot, room, allPlayers);
        } else {
          citizenBotLogic(bot, room, allPlayers);
        }
      });
    }, 7000);
  }

  function gangsterBotLogic(bot, room, allPlayers) {
    if(room.phase === 'investigation' && Math.random() < 0.3) {
      io.to(room.code).emit('publicMsg', {from: bot.name, msg: `my number is ${bot.number}. anyone sus?`});
    }
    if(room.phase === 'discussion' && Math.random() < 0.4) {
      const target = allPlayers.filter(p=>p.role!=='Gangster' && p.alive && p.id!==bot.id);
      const sus = target[Math.floor(Math.random()*target.length)];
      if(sus) io.to(room.code).emit('publicMsg', {from: bot.name, msg: `${sus.name} is acting sus. vote them`});
    }
    if(room.phase === 'voting' && Math.random() < 0.8) {
      const target = allPlayers.filter(p=>p.role!=='Gangster' && p.alive && p.id!==bot.id);
      const voteTarget = target[Math.floor(Math.random()*target.length)];
      if(voteTarget) {
        room.votes[voteTarget.id] = (room.votes[voteTarget.id] || 0) + 1;
        bot.hasVoted = true;
        io.to(room.code).emit('publicMsg', {from: bot.name, msg: `voting ${voteTarget.name}`});
        io.to(room.code).emit('playerList', getPlayerList(room.code));
      }
    }
  }

  function reporterBotLogic(bot, room, allPlayers) {
    if(room.phase === 'investigation' && Math.random() < 0.25) {
      const target = allPlayers.filter(p=>p.alive && p.id!==bot.id);
      const investigateTarget = target[Math.floor(Math.random()*target.length)];
      if(investigateTarget) {
        const result = investigateTarget.role === 'Gangster'? 'Gangster' : 'Not Gangster';
        if(result === 'Gangster' && Math.random() < 0.6) {
          io.to(room.code).emit('publicMsg', {from: bot.name, msg: `I think ${investigateTarget.name} is sus`});
        }
      }
    }
  }

  function policeBotLogic(bot, room, allPlayers) {
    if(room.phase === 'police') {
      const entries = Object.entries(room.votes);
      if(entries.length > 0) {
        room.policeVote = entries.reduce((a,b)=> room.votes[a[0]] > room.votes[b[0]]? a : b)[0];
      }
      endRound(room.code);
    }
  }

  function citizenBotLogic(bot, room, allPlayers) {
    if(room.phase === 'investigation' && bot.personality > 0.5 && Math.random() < 0.2) {
      io.to(room.code).emit('publicMsg', {from: bot.name, msg: `my number ${bot.number}. let's work together`});
    }
    if(room.phase === 'discussion' && Math.random() < 0.3) {
      const sus = pickSuspect(room, allPlayers);
      if(sus) io.to(room.code).emit('publicMsg', {from: bot.name, msg: `${sus.name} hasn't said much`});
    }
    if(room.phase === 'voting' && Math.random() < 0.7) {
      const sus = pickSuspect(room, allPlayers);
      if(sus && sus.id!==bot.id) {
        room.votes[sus.id] = (room.votes[sus.id] || 0) + 1;
        bot.hasVoted = true;
        io.to(room.code).emit('publicMsg', {from: bot.name, msg: `voting ${sus.name}`});
        io.to(room.code).emit('playerList', getPlayerList(room.code));
      }
    }
  }

  function pickSuspect(room, alivePlayers) {
    if(alivePlayers.length === 0) return null;
    const quiet = alivePlayers.filter(p => (room.messageCount[p.id] || 0) === 0);
    if(quiet.length > 0) return quiet[Math.floor(Math.random()*quiet.length)];
    const entries = Object.entries(room.votes);
    if(entries.length > 0) {
      const mostVotedId = entries.reduce((a,b)=> room.votes[a[0]] > room.votes[b[0]]? a : b)[0];
      return alivePlayers.find(p=>p.id === mostVotedId);
    }
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
    if(!rooms[code]) return;
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
    if(!rooms[code]) return;
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
    if(!rooms[code]) return;
    rooms[code].gangsterKillVotes[targetId] = (rooms[code].gangsterKillVotes[targetId] || 0) + 1;
  });

  socket.on('reporterInvestigate', ({code, targetId}) => {
    if(!rooms[code]) return;
    const room = rooms[code];
    const target = [...room.players,...room.bots].find(p=>p.id===targetId);
    const result = target.role === 'Gangster'? 'Gangster' : 'Not Gangster';
    socket.emit('investigationResult', {target: target.name, result});
  });

  function endRound(code) {
    if(!rooms[code]) return;
    processRoundActions(code);
    rooms[code].round++;
    startInvestigation(code);
  }

  function processRoundActions(code) {
    if(!rooms[code]) return;
    const room = rooms[code];
    const allPlayers = [...room.players,...room.bots];

    const killEntries = Object.entries(room.gangsterKillVotes);
    const killTargetId = killEntries.length > 0? killEntries.reduce((a,b)=> room.gangsterKillVotes[a[0]] > room.gangsterKillVotes[b[0]]? a : b)[0] : null;
    if(killTargetId) {
      const killed = allPlayers.find(p=>p.id===killTargetId);
      if(killed) {
        killed.alive = false;
        io.to(code).emit('elimination', {type: 'gangster kill', name: killed.name, role: killed.role});
      }
    }

    if(room.policeVote) {
      const voted = allPlayers.find(p=>p.id===room.policeVote);
      if(voted && voted.alive) {
        voted.alive = false;
        io.to(code).emit('elimination', {type: 'police elimination', name: voted.name, role: voted.role});
      }
    }
  }

  function checkWin(code) {
    if(!rooms[code]) return false;
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
    if(!rooms[code]) return;
    const winner = checkWin(code);
    io.to(code).emit('gameOver', {winner, message: winner === 'gangsters'? 'Gangsters + Neutral Win!' : 'Police + Citizens + Neutral Win!'});
  }

  socket.on('disconnect', () => console.log("User disconnected:", socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Room of Lies v1.9.5 on port ${PORT}`));
