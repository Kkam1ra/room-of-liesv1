const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

const PORT = process.env.PORT || 3000;
const rooms = {};

// 200 PUZZLE POOL - ADD THE REST HERE
const PUZZLES = [
  {type:'logic', q:'A train leaves A at 60mph. B leaves 2h later at 90mph. 540 miles apart. Where meet?', realClue:'180mi from B. Check who came from B.', fakeClue:'240mi from A. Check who came from A.'},
  {type:'evidence', q:'Knife 3 prints. Kitchen: #2,#4,#7.', realClue:'Check #2,#4,#7.', fakeClue:'Check #1,#3,#5.'},
  {type:'logic', q:'3 suspects. Only 1 lying. A: B did it. B: C did it. C: Im innocent.', realClue:'If C innocent, then A or B lying. Check who benefits.', fakeClue:'B is lying so A did it.'},
  //... PASTE YOUR OTHER 197 PUZZLES HERE IN SAME FORMAT
];

const BOT_NAMES = ['Tony','Sal','Vince','Big Mike','Lucy','Frankie','Joey','Maria','Carlo','Rosa'];

function generateRoles(count){
  let gangCount = count >= 11? Math.floor(count*0.2) : Math.floor(count*0.3);
  if(gangCount<2) gangCount=2;
  const roles = ['Police']; if(count>9) roles.push('Police'); roles.push('Reporter');
  for(let i=0;i<Math.floor(count*0.15);i++) roles.push('Neutral');
  for(let i=0;i<gangCount;i++) roles.push('Gangster');
  while(roles.length<count) roles.push('Citizen');
  return roles.sort(()=>Math.random()-0.5);
}
function makeId() { return Math.random().toString(36).substring(2,9); } // NO UUID
function initBotMemory() { return {roundHistory: [], votes: [], accusations: {}, susList: new Set(), frameTarget: null, allyIds: []}; }

io.on('connection', (socket) => {
  socket.on('createRoom', ({playerName}) => {
    const code = makeId().toUpperCase();
    rooms[code] = {code,players:[],alliances:[],phase:'lobby',round:0,votes:{},gangVotes:{},currentPuzzle:null,isLieRound:false};
    rooms[code].players.push({id:socket.id,name:playerName,alive:true,isBot:false});
    socket.join(code); socket.emit('roomCreated', {code});
  });

  socket.on('joinRoom', ({code, playerName}) => {
    if(!rooms[code]) return; rooms[code].players.push({id:socket.id,name:playerName,alive:true,isBot:false});
    io.to(code).emit('playerList', rooms[code].players);
  });

  socket.on('addBot', (code) => {
    const room=rooms[code]; const botId='bot_'+makeId();
    room.players.push({id:botId,name:BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)]+' Bot',isBot:true,personality:'smart',alive:true,memory: initBotMemory(), fakeNumber: null});
    io.to(code).emit('playerList', room.players);
  });

  socket.on('startGame', (code) => {
    const room=rooms[code]; if(room.players.length<7) return socket.emit('systemMsg','Need min 7 players');
    const roles=generateRoles(room.players.length);
    room.players.forEach((p,i)=>{
      p.role=roles[i]; p.number=i+1;
      p.team=['Gangster'].includes(p.role)?'Gangster':['Police','Reporter','Citizen'].includes(p.role)?'Citizen':'Neutral';
      if(p.role==='Neutral') p.teamCard=Math.random()>0.5?'Team Police':'Team Gangster';
      if(p.isBot && p.role==='Gangster') p.fakeNumber = Math.floor(Math.random()*room.players.length)+1;
      io.to(p.id).emit('roleAssigned',{role:p.role,team:p.team,number:p.number,teamCard:p.teamCard});
    });
    startRound(code);
  });

  function startRound(code){
    const room=rooms[code]; room.round++; room.votes={}; room.gangVotes={};
    if(room.round>5) return checkWin(code);
    const puzzle=PUZZLES[Math.floor(Math.random()*PUZZLES.length)]; room.currentPuzzle = puzzle;
    room.isLieRound=Math.random()<0.3;
    io.to(code).emit('roundStart',{round:room.round,clue:puzzle.q});
    io.to(code).emit('secretClue',`CLUE: ${puzzle.realClue}`);
    if(room.isLieRound){ room.players.filter(p=>p.role==='Gangster'&&p.alive).forEach(g=>{ io.to(g.id).emit('secretClue',`GANGSTER FAKE: ${puzzle.fakeClue}`); }); io.to(code).emit('systemMsg','⚠️ Intel: False info may be circulating this round'); }
    else { io.to(code).emit('systemMsg','Intel: All info verified this round'); }
    setPhase(code,'investigation',25*60*1000,()=>setPhase(code,'discussion',3*60*1000,()=>setPhase(code,'voting',30*1000,()=>gangPhase(code))));
  }

  function setPhase(code,phase,time,next){ const room=rooms[code]; room.phase=phase; io.to(code).emit('phaseChange',{phase,time}); setTimeout(next,time); }
  function gangPhase(code){ setPhase(code,'gangster',30*1000,()=>{ const room=rooms[code]; const votes=Object.values(room.gangVotes); if(votes.length>0){ const counts={}; votes.forEach(v=>counts[v]=(counts[v]||0)+1); const target=Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b); eliminatePlayer(code,target,'Gangster'); } policePhase(code); }); }
  function policePhase(code){ const room=rooms[code]; const police=room.players.filter(p=>p.role==='Police'&&p.alive); if(police.length>1) setPhase(code,'police_discuss',30*1000,()=>setPhase(code,'police_vote',30*1000,()=>tallyPolice(code))); else setPhase(code,'police_vote',30*1000,()=>tallyPolice(code)); }
  function tallyPolice(code){ const room=rooms[code]; const votes=Object.values(room.votes).filter(id=>room.players.find(p=>p.id===id&&p.role==='Police')); if(votes.length>0){ const counts={}; votes.forEach(v=>counts[v]=(counts[v]||0)+1); const target=Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b); eliminatePlayer(code,target,'Police'); } startRound(code); }
  function eliminatePlayer(code,id,by){ const p=rooms[code].players.find(x=>x.id===id); if(p){p.alive=false; io.to(code).emit('systemMsg',`💀 ${p.name} #${p.number} eliminated. Role: ${p.role} by ${by}`)} checkWin(code); }
  function checkWin(code){ const room=rooms[code]; const alive=room.players.filter(p=>p.alive); const g=alive.filter(p=>p.team==='Gangster'); const c=alive.filter(p=>p.team==='Citizen'); const pol=alive.filter(p=>p.role==='Police'); if(g.length===0) return endGame(code,'Citizens + Police Win!'); if(g.length>=c.length+pol.length) return endGame(code,'Gangsters Win - Majority!'); if(pol.length===0) return endGame(code,'Gangsters Win - All Police Dead!'); if(room.round>=5 && g.length>0) return endGame(code,'Gangsters Win - Survived 5 Rounds!'); }
  function endGame(code,msg){ io.to(code).emit('gameOver',{message:msg}); }

  socket.on('createAlliance',({code,memberIds})=>{ rooms[code].alliances.push({id:makeId(),members:[socket.id,...memberIds]}); });
  socket.on('vote',({code,targetId})=>{rooms[code].votes[socket.id]=targetId});
  socket.on('gangVote',({code,targetId})=>{rooms[code].gangVotes[socket.id]=targetId});
  socket.on('publicMessage',({code,msg})=>{io.to(code).emit('publicMsg',{from:'Player',msg})});
  socket.on('joinVoice',({code,roomType})=>{socket.join(code+'_'+roomType)});
});

server.listen(PORT, ()=>console.log('v5.6.0 Running on', PORT));
