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

// 200 PUZZLES
const PUZZLES = Array.from({length:200}, (_,i)=>({
  type:['logic','evidence','alibi'][i%3],
  q:`Case ${i+1}: Puzzle question here`,
  realClue:`Check player #${(i%10)+1}`,
  fakeClue:`Frame player #${((i+3)%10)+1}`
}));

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

// SMART BOT AI
function botThink(room, bot){
  const alive = room.players.filter(p=>p.alive);
  if(room.phase==='discussion'){
    // Accuse someone randomly but favor sus people
    const target = alive.filter(p=>p.id!==bot.id)[Math.floor(Math.random()*alive.length)];
    if(target && Math.random()>0.5) io.to(room.code).emit('publicMsg',{from:bot.name,msg:`I think #${target.number} is sus. ${room.currentPuzzle.realClue}`});
  }
  if(room.phase==='voting'){
    const target = alive.filter(p=>p.id!==bot.id)[0];
    if(target) room.votes[bot.id]=target.id;
  }
  if(room.phase==='gangster' && bot.role==='Gangster'){
    const target = alive.filter(p=>p.team!=='Gangster')[0];
    if(target) room.gangVotes[bot.id]=target.id;
  }
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

  function addBotsToRoom(code, count){
    if(!rooms[code]) return;
    for(let i=0;i<count;i++){
      const botId='bot_'+id();
      rooms[code].players.push({id:botId,name:BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)]+' Bot',isBot:true,alive:true});
    }
    io.to(code).emit('playerList', rooms[code].players);
  }

  socket.on('startCountdown', (code) => {
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
    const room=rooms[code];
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
    const room=rooms[code]; room.round++; room.votes={}; room.gangVotes={};
    if(room.round>5) return checkWin(code);
    const puzzle=PUZZLES[Math.floor(Math.random()*PUZZLES.length)]; room.currentPuzzle = puzzle;
    room.isLieRound=Math.random()<0.3;
    io.to(code).emit('roundStart',{round:room.round,clue:puzzle.q});
    room.players.filter(p=>!p.isBot).forEach(p=> io.to(p.id).emit('secretClue',`CLUE: ${puzzle.realClue}`));
    if(room.isLieRound){ room.players.filter(p=>p.role==='Gangster'&&p.alive).forEach(g=>{ io.to(g.id).emit('secretClue',`GANGSTER FAKE: ${puzzle.fakeClue}`); }); io.to(code).emit('systemMsg','⚠️ False info may be circulating'); }
    else { io.to(code).emit('systemMsg','Intel: All info verified'); }
    setPhase(code,'investigation',25*60*1000,()=>setPhase(code,'discussion',3*60*1000,()=>setPhase(code,'voting',30*1000,()=>gangPhase(code))));
  }

  function setPhase(code,phase,time,next){
    const room=rooms[code]; room.phase=phase; io.to(code).emit('phaseChange',{phase});
    // Bot AI runs every phase
    room.players.filter(p=>p.isBot&&p.alive).forEach(bot=> setTimeout(()=>botThink(room,bot), 5000));
    setTimeout(next,time);
  }
  function gangPhase(code){ setPhase(code,'gangster',30*1000,()=>{ const room=rooms[code]; const votes=Object.values(room.gangVotes); if(votes.length>0){ const counts={}; votes.forEach(v=>counts[v]=(counts[v]||0)+1); const target=Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b); eliminatePlayer(code,target,'Gangster'); } policePhase(code); }); }
  function policePhase(code){ const room=rooms[code]; const police=room.players.filter(p=>p.role==='Police'&&p.alive); if(police.length>1) setPhase(code,'police_discuss',30*1000,()=>setPhase(code,'police_vote',30*1000,()=>tallyPolice(code))); else setPhase(code,'police_vote',30*1000,()=>tallyPolice(code)); }
  function tallyPolice(code){ const room=rooms[code]; const votes=Object.values(room.votes).filter(id=>room.players.find(p=>p.id===id&&p.role==='Police')); if(votes.length>0){ const counts={}; votes.forEach(v=>counts[v]=(counts[v]||0)+1); const target=Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b); eliminatePlayer(code,target,'Police'); } startRound(code); }
  function eliminatePlayer(code,id,by){ const p=rooms[code].players.find(x=>x.id===id); if(p){p.alive=false; io.to(code).emit('systemMsg',`💀 ${p.name} #${p.number} eliminated. Role: ${p.role} by ${by}`)} checkWin(code); }
  function checkWin(code){ const room=rooms[code]; const alive=room.players.filter(p=>p.alive); const g=alive.filter(p=>p.team==='Gangster'); const c=alive.filter(p=>p.team==='Citizen'); const pol=alive.filter(p=>p.role==='Police'); if(g.length===0) return endGame(code,'Citizens + Police Win!'); if(g.length>=c.length+pol.length) return endGame(code,'Gangsters Win - Majority!'); if(pol.length===0) return endGame(code,'Gangsters Win - All Police Dead!'); if(room.round>=5 && g.length>0) return endGame(code,'Gangsters Win - Survived 5 Rounds!'); }
  function endGame(code,msg){ io.to(code).emit('gameOver',{message:msg}); delete rooms[code]; }

  socket.on('vote',({code,targetId})=>{if(rooms[code])rooms[code].votes[socket.id]=targetId});
  socket.on('gangVote',({code,targetId})=>{if(rooms[code])rooms[code].gangVotes[socket.id]=targetId});
  socket.on('publicMessage',({code,msg})=>{io.to(code).emit('publicMsg',{from:'Player',msg})});

  // WEBRTC SIGNALING FOR MIC
  socket.on('joinVoice', ({code, roomType}) => socket.join(code+'_'+roomType));
  socket.on('voiceSignal', ({code, roomType, data}) => socket.to(code+'_'+roomType).emit('voiceSignal', {id:socket.id, data}));
});

server.listen(PORT, '0.0.0.0', ()=>console.log('v5.7.0 Running on', PORT));
