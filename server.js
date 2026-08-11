const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function assignRoles(players) {
  const roles = ['Civilian', 'Civilian'];
  if(players.length >= 4) roles.push('Gangster', 'Gangster');
  if(players.length >= 5) roles.push('Police');
  if(players.length >= 6) roles.push('Reporter');
  if(players.length >= 7) roles.push('Doctor');
  while(roles.length < players.length) roles.push('Civilian');
  roles.sort(() => Math.random() - 0.5);
  players.forEach((p, i) => {
    p.role = roles[i];
    p.number = i + 1;
    p.alive = true;
    p.hasVoted = false;
    p.trustPartner = null;
  });
}

function generateClue(room) {
  const alive = room.players.filter(p => p.alive);
  const sum = alive.reduce((a, b) => a + b.number, 0);
  const product = alive.reduce((a, b) => a * b.number, 1);
  const highest = Math.max(...alive.map(p => p.number));
  const lowest = Math.min(...alive.map(p => p.number));

  const clues = [
    `The sum of all living player numbers is ${sum}`,
    `Multiply all living player numbers. The last digit is ${product % 10}`,
    `The highest player number is ${highest}`,
    `The lowest player number is ${lowest}`,
    `There are ${alive.length} players alive`,
    `The sum is ${sum}. Is it even or odd? Answer: ${sum % 2 === 0? 'Even' : 'Odd'}`,
    `At least one player number is a prime number`,
    `The average of all numbers is ${(sum/alive.length).toFixed(1)}`
  ];
  return clues[Math.floor(Math.random() * Math.min(room.round + 2, clues.length))];
}

function startGame(room) {
  room.round = 1;
  room.totalRounds = 3;
  room.earlyVoteRequests = 0;
  room.votes = {};
  assignRoles(room.players);
  room.players.forEach(p => {
    io.to(p.id).emit('roleAssigned', {
      role: p.role,
      number: p.number,
      agenda: p.role === 'Gangster'? 'Eliminate everyone else' : 'Find the Gangsters',
      team: p.role ===
