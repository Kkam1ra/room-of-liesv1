const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
const rooms = {};
const id = () => Math.random().toString(36).substring(2,9);

// 200 BRAIN-BREAKER PUZZLES - NO OBJECTS, ONLY LOGIC/GAMES
const PUZZLES = [
  {q:'HI-LO: I picked 1-20. 3 guesses. I say HI/LO. Solve in 3 = Citizens get truth', real:'Binary: 10, then 5/15, then split', fake:'Start at 1 and count up'},
  {q:'BETTING: Everyone writes 1-5 secretly. Majority = truth. Tie = Gangsters win', real:'Watch who copies votes. Gangsters coordinate', fake:'Always pick 3'},
  {q:'PATTERN: 2, 6, 12, 20, 30,?. +4,+6,+8,+10... Next?', real:'+12 = 42', fake:'+10 = 40'},
  {q:'GRID: 3x3 Lights Out. Toggle flips self+neighbors. Solve to win info', real:'Start with corners, work in', fake:'Spam middle button'},
  {q:'MONTY HALL: 3 doors. You pick 2. I open 3 - empty. Switch or stay?', real:'Switch. 2/3 vs 1/3', fake:'Stay. 50/50'},
  {q:'2 GUARDS: 1 lies, 1 truth. 1 door wins. 1 question', real:'Ask what other guard would say, pick opposite', fake:'Ask if this is correct door'},
  {q:'MEMORY: I list 7 numbers. Repeat backwards in 30s or lose vote', real:'Chunk 3-3-1 and rehearse', fake:'Remember first and last only'},
  {q:'PARADOX: This statement is false. Believe it = lose vote', real:'Abstain. It cannot be resolved', fake:'It is true. Take the vote'},
  {q:'VOTE ANALYSIS: 3 voted #2. 2 voted #5. #2 was innocent', real:'Gangsters bus early. Check #2 voters', fake:'#5 got votes. #5 is gang'},
  {q:'SEATING: 7 in circle. #1 not next #2. #3 across #5. #4 next #6', real:'Draw it. Only 2 solutions', fake:'Put 1-7 in order'},
];
const types = ['HI-LO','PATTERN','GRID','PROBABILITY','PARADOX','MEMORY','LOGIC'];
while(PUZZLES.length < 200){
  const t = types[PUZZLES.length % 7];
  PUZZLES.push({
    q:`${t} CHALLENGE ${PUZZLES.length+1}: Solve under 25min pressure`,
    real:`Find the trick. Break it into steps`,
    fake:`Trust your first instinct`
  })
}

const BOT_NAMES = ['Tony','Sal','Vince','Big Mike','Lucy','Frankie','Joey','Maria','Carlo','Rosa'];

function generateRoles(count){
  let gangCount = count >= 11? Math.floor(count*0.2) : Math.floor(count*0.3);
  if(gangCount<2) gangCount=2;
  const roles = ['Police']; if(count>9) roles.push('Police');
  roles.push('Reporter');
  for(let i=0;i<Math.floor(count*0.15);i++) roles.push('Neutral');
  for(let i=0;i<gangCount;i++) roles.push('Gangster');
  while(roles.length<count) roles.push('Citizen');
  return roles.sort(()=>Math.random()-0.5);
}

function botThink(room, bot){
  try{
    const alive = room.players.filter(p=>p.alive &&!p.isBot);
    if(room.phase==='discussion' && alive.length>0 && Math.random()>0.4){
      const target = alive[Math.floor(Math.random()*alive.length)];
      const clue = room.isLieRound? room.currentPuzzle.fake : room.currentPuzzle.real;
      io.to(room.code).emit('publicMsg',{from:bot.name,msg:`#${target.number}: ${clue}`});
    }
    if(room.phase==='voting'){
      const target = alive[0];
      if(target) room.votes[bot.id]=target.id;
    }
    if(room.phase==='gangster' && bot.role==='Gangster'){
      const target = room.players.find(p=>p.alive && p.team!=='Gangster');
      if(target) room.gangVotes[bot.id]=target.id;
    }
  }catch(e){ console.log('Bot error:',e) }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({playerName}) => {
    const code = id().toUpperCase();
    rooms[code] = {code,players:[],alliances:[],phase:'lobby',round:0,votes:{},gangVotes:{},startTimer:null};
    rooms[code].players.push({id:socket.id,name:playerName,alive:true,isBot:false});
    socket.join(code); socket.emit('roomCreated', {code}); io.to(code).emit('playerList', rooms[code].players);
  });

  socket.on('joinRoom', ({code, playerName}) => {
    if(!rooms[code]) return socket.emit('systemMsg','Room not found');
    rooms[code].players.push({id:socket.id,name:playerName,alive:true,isBot:false});
    io.to(code).emit('playerList', rooms[code].players);
  });

  socket.on('addBot', (code) => addBotsToRoom(code, 1));
  socket.on('createAlliance', ({code, targetId}) => {
    if(!rooms[code]) return;
    rooms[code].alliances.push({id:id(), members:[socket.id, targetId]});
    io.to(code).emit('systemMsg', `🤝 Alliance formed`);
  });

  function addBotsToRoom(code, count){
    if(!rooms[code]) return;
    for(let i=0;i<count;i++){
      const botId='bot_'+id();
      rooms[code].players.push({id:botId,name:BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)]+' Bot',isBot:true,alive:true});
    }
    io.to(code).emit('playerList', rooms[code].players);
  }

  socket.on('startCountdown', (code) => {
    if(!rooms[code]) return;
    if(rooms[code].startTimer) clearTimeout(rooms[code].startTimer);
    io.to(code).emit('countdownStart', 60);
    rooms[code].startTimer = setTimeout(()=>{
      const room = rooms[code];
      if(room.players.length < 7){
        const needed = 7 - room.players.length;
        addBotsToRoom(code, needed);
        io.to(code).emit('systemMsg', `Auto-filled ${needed} bots. Starting game.`);
      }
      startGame(code);
    }, 60000);
  });

  function startGame(code){
    const room=rooms[code]; if(!room) return;
    const roles=generateRoles(room.players.length);
    room.players.forEach((p,i)=>{
      p.role=roles[i]; p.number=i+1;
      p.team=['Gangster'].includes(p.role)?'Gangster':['Police','Reporter','Citizen'].includes(p.role)?'Citizen':'Neutral';
      if(p.role==='Neutral') p.teamCard=Math.random()>0.5?'Team Police':'Team Gangster';
      io.to(p.id).emit('roleAssigned',{role:p.role,team:p.team,number:p.number,teamCard:p.teamCard});
    });
    startRound(code);
  }

  function startRound(code){
    const room=rooms[code]; if(!room) return;
    room.round++; room.votes={}; room.gangVotes={};
    if(room.round>5) return checkWin(code);
    const puzzle=PUZZLES[Math.floor(Math.random()*PUZZLES.length)]; room.currentPuzzle = puzzle;
    room.isLieRound=Math.random()<0.3;
    io.to(code).emit('roundStart',{round:room.round,clue:puzzle.q});
    room.players.filter(p=>!p.isBot).forEach(p=> io.to(p.id).emit('secretClue',`YOUR CLUE: ${puzzle.real}`));
    if(room.isLieRound){
      room.players.filter(p=>p.role==='Gangster'&&p.alive).forEach(g=>{
        io.to(g.id).emit('secretClue',`FAKE CLUE: ${puzzle.fake}`);
      });
      io.to(code).emit('systemMsg','⚠️ Intel: False information may be in play');
    } else {
      io.to(code).emit('systemMsg','Intel: All information verified this round');
    }
    setPhase(code,'investigation',25*60*1000,()=>setPhase(code,'discussion',3*60*1000,()=>setPhase(code,'voting',30*1000,()=>gangPhase(code))));
  }

  function setPhase(code,phase,time,next){
    const room=rooms[code]; if(!room) return;
    room.phase=phase; io.to(code).emit('phaseChange',{phase});
    room.players.filter(p=>p.isBot&&p.alive).forEach(bot=> setTimeout(()=>botThink(room,bot), 7000));
    setTimeout(next,time);
  }
  function gangPhase(code){ setPhase(code,'gangster',30*1000,()=>{ const room=rooms[code]; if(!room) return; const votes=Object.values(room.gangVotes); if(votes.length>0){ const counts={}; votes.forEach(v=>counts[v]=(counts[v]||0)+1); const target=Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b); eliminatePlayer(code,target,'Gangster'); } policePhase(code); }); }
  function policePhase(code){ const room=rooms[code]; if(!room) return; const police=room.players.filter(p=>p.role==='Police'&&p.alive); if(police.length>1) setPhase(code,'police_discuss',30*1000,()=>setPhase(code,'police_vote',30*1000,()=>tallyPolice(code))); else setPhase(code,'police_vote',30*1000,()=>tallyPolice(code)); }
  function tallyPolice(code){ const room=rooms[code]; if(!room) return; const votes=Object.values(room.votes).filter(id=>room.players.find(p=>p.id===id&&p.role==='Police')); if(votes.length>0){ const counts={}; votes.forEach(v=>counts[v]=(counts[v]||0)+1); const target=Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b); eliminatePlayer(code,target,'Police'); } startRound(code); }
  function eliminatePlayer(code,id,by){ const room=rooms[code]; if(!room) return; const p=room.players.find(x=>x.id===id); if(p){p.alive=false; io.to(code).emit('systemMsg',`💀 ${p.name} #${p.number} eliminated. Role: ${p.role} by ${by}`)} checkWin(code); }
  function checkWin(code){ const room=rooms[code]; if(!room) return; const alive=room.players.filter(p=>p.alive); const g=alive.filter(p=>p.team==='Gangster'); const c=alive.filter(p=>p.team==='Citizen'); const pol=alive.filter(p=>p.role==='Police'); if(g.length===0) return endGame(code,'Citizens + Police Win!'); if(g.length>=c.length+pol.length) return endGame(code,'Gangsters Win - Majority!'); if(pol.length===0) return endGame(code,'Gangsters Win - All Police Dead!'); if(room.round>=5 && g.length>0) return endGame(code,'Gangsters Win - Survived 5 Rounds!'); }
  function endGame(code,msg){ io.to(code).emit('gameOver',{message:msg}); delete rooms[code]; }

  socket.on('vote',({code,targetId})=>{if(rooms[code])rooms[code].votes[socket.id]=targetId});
  socket.on('gangVote',({code,targetId})=>{if(rooms[code])rooms[code].gangVotes[socket.id]=targetId});
  socket.on('publicMessage',({code,msg})=>{if(rooms[code])io.to(code).emit('publicMsg',{from:'Player',msg})});
  socket.on('disconnect', ()=>{ for(const code in rooms){ rooms[code].players = rooms[code].players.filter(p=>p.id!==socket.id); io.to(code).emit('playerList', rooms[code].players); }})
});

server.listen(PORT, '0.0.0.0', ()=>console.log('v5.9.0 FINAL Running on', PORT));
