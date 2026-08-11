const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(path.join(__dirname, 'public')));
const rooms = {};

const PHASE_TIME = { investigation: 150000, discussion: 18000, voting: 30000, police: 30000, gangster: 30000 }; // 2.5min for testing

const BOT_NAMES = ["Alex","Maya","Chris","Zara","Leo","Nina","Omar","Priya","Sam","Tess"];
const BOT_PERSONALITIES = ["Aggressive","Quiet","Helpful","Suspicious","Funny","Leader","Follower","Liar"];

const gamePool = [
...Array(25).fill().map((_,i)=>({cat:'BEHAVIOR',public:`BEHAVIOR ${i+1}: On 3...2...1...TYPE YOUR NUMBER`,civilian:"Type on 1",gangster:"Wait 1s"})),
...Array(25).fill().map((_,i)=>({cat:'SOCIAL',public:`SOCIAL ${i+1}: DM 2+ people to form private alliance`,civilian:"Pick anyone",gangster:"Pick gangsters"})),
...Array(25).fill().map((_,i)=>({cat:'BETTING',public:`BETTING ${i+1}: Solve 15x17=?`,civilian:"255",gangster:"250"})),
...Array(25).fill().map((_,i)=>({cat:'CHAOS',public:`CHAOS ${i+1}: Count 1-30. 1 per person`,civilian:"In order",gangster:"Skip primes"})),
...Array(25).fill().map((_,i)=>({cat:'LOGIC',public:`LOGIC ${i+1}: 3x3 grid sum to 15`,civilian:"Use magic square",gangster:"Random"})),
...Array(25).fill().map((_,i)=>({cat:'MEMORY',public:`MEMORY ${i+1}: Memorize 20 digits. Type backwards`,civilian:"Reverse",gangster:"Forward"})),
...Array(25).fill().map((_,i)=>({cat:'CREATIVE',public:`CREATIVE ${i+1}: 'The vault opened...' 10 words`,civilian:"Be innocent",gangster:"Add violence"})),
...Array(25).fill().map((_,i)=>({cat:'TRICK',public:`TRICK ${i+1}: First to type PINEAPPLE`,civilian:"PINEAPPLE",gangster:"APPLE"})),
...Array(25).fill().map((_,i)=>({cat:'HARD',public:`HARD ${i+1}: Solve (x+2)(x-2)=15`,civilian:"x=4 or -4",gangster:"x=5"})),
];

function genCode(){return Math.random().toString(36).substring(2,6).toUpperCase()}

function assignRoles(players){
  const total=players.length; if(total<7) return false;
  const gangsters=Math.max(1,Math.floor(total/4)); const police=Math.max(1,Math.floor(total/8));
  const reporter=1; const neutrals=Math.max(1,Math.floor(total/6)); const normals=total-gangsters-police-reporter-neutrals;
  const roles=[].concat(Array(gangsters).fill('Gangster'),Array(police).fill('Police'),Array(reporter).fill('Reporter'),Array(neutrals).fill('Neutral'),Array(normals).fill('Normal')).sort(()=>Math.random()-0.5);
  players.forEach((p,i)=>{p.role=roles[i]; p.number=i+1; p.alive=true; p.hasVoted=false; p.usedPower=false; p.hasKillVoted=false; p.personality=BOT_PERSONALITIES[Math.floor(Math.random()*BOT_PERSONALITIES.length)]; p.teamCard=p.role==='Neutral'?(Math.random()<0.5?'POLICE':'GANGSTER'):null})
  return true;
}

function generateGame(room){let available=gamePool.filter(g=>!room.usedGames?.includes(g.public)); if(available.length===0){room.usedGames=[];available=gamePool} const game=available[Math.floor(Math.random()*available.length)]; room.usedGames=[...(room.usedGames||[]),game.public]; return {public:`GAME [${game.cat}]: ${game.public}`,civilian:`BRIEF: ${game.civilian}`,gangster:`BRIEF: ${game.gangster}`}}

function eliminatePlayer(room,targetId,killer){const target=room.players.find(p=>p.id===targetId); if(target&&target.alive){target.alive=false; io.to(room.code).emit('systemMsg',`💀 ${killer} ELIMINATED: ${target.name} #${target.number}. Role: ${target.role}`); return true} return false}

function botThink(room,bot){if(!bot.alive||room.phase==='lobby')return; const alive=room.players.filter(p=>p.alive&&p.id!==bot.id); if(room.phase==='investigation'){let brief=bot.role==='Gangster'&&room.gangstersHaveFakeInfo?room.currentGame.gangster:room.currentGame.civilian; setTimeout(()=>{const msg=brief.replace('BRIEF: ',''); io.to(room.code).emit('publicMsg',{from:bot.name,msg}); io.to(room.code).emit('botSpeak',{from:bot.name,msg});},3000)} if(room.phase==='voting'&&!bot.hasVoted){const voteTarget=alive[Math.floor(Math.random()*alive.length)]; room.votes[voteTarget.id]=(room.votes[voteTarget.id]||0)+1;bot.hasVoted=true; io.to(room.code).emit('voteUpdate',room.votes)} if(room.phase==='gangster'&&bot.role==='Gangster'&&!bot.hasKillVoted){bot.hasKillVoted=true; const target=alive[Math.floor(Math.random()*alive.length)]; room.gangsterKillVotes[target.id]=(room.gangsterKillVotes[target.id]||0)+1;} if(room.phase==='police'&&bot.role==='Police'){const targetId=Object.keys(room.votes).reduce((a,b)=>room.votes[a]>room.votes[b]?a:b,null); room.policeChoice=targetId;}}

function startGame(room){if(!assignRoles(room.players)) return; room.round=1;room.totalRounds=3;room.usedGames=[]; room.players.forEach(p=>{if(!p.isBot){let payload={role:p.role,number:p.number,team:p.role==='Gangster'?'Gangster':'Citizens'}; if(p.role==='Neutral')payload.teamCard=p.teamCard; if(p.role==='Police')payload.power='After vote, discuss 30s then pick who dies'; if(p.role==='Reporter')payload.power='Investigate 1 person during discussion'; io.to(p.id).emit('roleAssigned',payload)}}); startRound(room)}

function startRound(room){room.phase='investigation';room.votes={};room.policeChoice=null;room.gangsterKillVotes={}; room.players.forEach(p=>{p.hasVoted=false;p.usedPower=false;p.hasKillVoted=false}); room.currentGame=generateGame(room); room.gangstersHaveFakeInfo=Math.random()<0.3; io.to(room.code).emit('roundStart',{round:room.round,total:room.totalRounds,clue:room.currentGame.public}); room.players.forEach(p=>{if(!p.isBot&&p.alive){let brief=(p.role==='Gangster'&&room.gangstersHaveFakeInfo)?room.currentGame.gangster:room.currentGame.civilian; io.to(p.id).emit('secretClue',brief)}}); changePhase(room,'investigation')}

function changePhase(room,phase){room.phase=phase;io.to(room.code).emit('phaseChange',{phase,time:PHASE_TIME[phase]}); clearTimeout(room.phaseTimer); room.phaseTimer=setTimeout(()=>nextPhase(room),PHASE_TIME[phase])}

function nextPhase(room){if(room.phase==='investigation')changePhase(room,'discussion'); else if(room.phase==='discussion')changePhase(room,'voting'); else if(room.phase==='voting')changePhase(room,'police'); else if(room.phase==='police'){const targetId=room.policeChoice||Object.keys(room.votes).reduce((a,b)=>(room.votes[a]>room.votes[b])?a:b,null); if(targetId)eliminatePlayer(room,targetId,'POLICE'); changePhase(room,'gangster')} else if(room.phase==='gangster'){const skipVotes=room.gangsterKillVotes['SKIP']||0; let maxVotes=0;let targetId=null; for(let id in room.gangsterKillVotes){if(id!=='SKIP'&&room.gangsterKillVotes[id]>maxVotes){maxVotes=room.gangsterKillVotes[id];targetId=id}} if(skipVotes<maxVotes&&targetId)eliminatePlayer(room,targetId,'GANGSTERS'); else io.to(room.code).emit('systemMsg',`GANGSTERS SKIPPED ELIMINATION`); checkWin(room)}}

function checkWin(room){const gangstersAlive=room.players.filter(p=>p.alive&&p.role==='Gangster').length; const policeAlive=room.players.filter(p=>p.alive&&p.role==='Police').length; const citizensAlive=room.players.filter(p=>p.alive&&p.role!=='Gangster').length; if(gangstersAlive===0)endGame(room,'Citizens + Loyal Neutrals'); else if(policeAlive===0)endGame(room,'Gangsters + Traitor Neutrals'); else if(gangstersAlive>=citizensAlive)endGame(room,'Gangsters + Traitor Neutrals'); else if(room.round>=room.totalRounds){if(gangstersAlive>0)endGame(room,'Gangsters + Traitor Neutrals'); else endGame(room,'Citizens + Loyal Neutrals')} else{room.round++;startRound(room)}}

function endGame(room,winner){clearInterval(room.botInterval); const reveal=room.players.map(p=>`#${p.number} ${p.name}: ${p.role} ${p.teamCard?`[${p.teamCard}]`:''}`).join('\n'); io.to(room.code).emit('gameOver',{winner,message:`${winner} WIN!\n\nALL ROLES:\n${reveal}`})}

io.on('connection',(socket)=>{
  console.log('User connected:', socket.id);
  socket.on('createRoom',({playerName,isPrivate})=>{const code=genCode();rooms[code]={code,players:[],phase:'lobby',isPrivate,usedGames:[],alliances:{}}; socket.join(code);socket.playerName=playerName;rooms[code].players.push({id:socket.id,name:playerName});socket.emit('roomCreated',{code})});
  socket.on('joinRoom',({code,playerName})=>{const room=rooms[code];if(!room||room.phase!=='lobby')return; socket.join(code);socket.playerName=playerName;room.players.push({id:socket.id,name:playerName}); io.to(code).emit('playerList',room.players); if(room.players.length>=7){let t=10;io.to(code).emit('preGameCountdown',t); const countdown=setInterval(()=>{t--;io.to(code).emit('preGameCountdown',t);if(t<=0){clearInterval(countdown);startGame(room)}},1000)}});
  socket.on('addBot',(code)=>{const room=rooms[code];const name=BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)]; const bot={id:'bot'+Date.now(),name:name,isBot:true,alive:true}; room.players.push(bot);io.to(code).emit('playerList',room.players); if(room.players.length>=7&&!room.botInterval){room.botInterval=setInterval(()=>{room.players.filter(p=>p.isBot).forEach(bot=>botThink(room,bot))},4000)}});
  socket.on('publicMessage',({code,msg})=>{io.to(code).emit('publicMsg',{from:socket.playerName,msg})});
  socket.on('gangsterMessage',({code,msg})=>{rooms[code].players.forEach(p=>{if(p.role==='Gangster'&&p.alive)io.to(p.id).emit('gangsterMsg',{from:socket.playerName,msg})})}); // FIXED
  socket.on('createAlliance',({code,memberIds})=>{const id='alliance'+Date.now();rooms[code].alliances[id]=memberIds; memberIds.forEach(id=>io.to(id).emit('allianceCreated',{id,members:memberIds}))});
  socket.on('publicVote',({code,targetId})=>{const room=rooms[code];const player=room.players.find(p=>p.id===socket.id);if(player)player.hasVoted=true;room.votes[targetId]=(room.votes[targetId]||0)+1;io.to(code).emit('voteUpdate',room.votes)});
  socket.on('policeEliminate',({code,targetId})=>{const room=rooms[code];const police=room.players.find(p=>p.id===socket.id);if(police.role==='Police')room.policeChoice=targetId});
  socket.on('gangsterVoteKill',({code,targetId})=>{const room=rooms[code];const gangster=room.players.find(p=>p.id===socket.id); if(gangster.role!=='Gangster'||!gangster.alive||gangster.hasKillVoted)return; gangster.hasKillVoted=true;room.gangsterKillVotes[targetId]=(room.gangsterKillVotes[targetId]||0)+1});
  socket.on('useReporter',({code,targetId})=>{const room=rooms[code];const reporter=room.players.find(p=>p.id===socket.id); if(reporter.role!=='Reporter'||reporter.usedPower)return;reporter.usedPower=true; const target=room.players.find(p=>p.id===targetId); const lied=target.role==='Gangster'&&room.gangstersHaveFakeInfo; io.to(room.code).emit('publicMsg',{from:'REPORTER',msg:`${reporter.name} investigated ${target.name}: ${lied?'LIED':'TOLD TRUTH'}`})});
  socket.on('joinVoice', ({code, roomType}) => {socket.join(code + '-' + roomType); socket.to(code + '-' + roomType).emit('userJoinedVoice', socket.id);});
  socket.on('offer', ({code, roomType, offer, to}) => { io.to(to).emit('offer', {offer, from: socket.id}) });
  socket.on('answer', ({code, roomType, answer, to}) => { io.to(to).emit('answer', {answer, from: socket.id}) });
  socket.on('ice-candidate', ({code, roomType, candidate, to}) => { io.to(to).emit('ice-candidate', {candidate, from: socket.id}) });
  socket.on('leaveVoice', ({code, roomType}) => { socket.leave(code + '-' + roomType) });
  socket.on('disconnect',()=>{console.log('User disconnected:', socket.id)});
});
server.listen(process.env.PORT||3000,()=>console.log('Server running on http://localhost:3000'))
