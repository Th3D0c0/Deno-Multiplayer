"use strict";
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const grid_width = 30;
const grid_length = 20;
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws`);
let myId = null;
let players = {};
socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "init") {
        myId = msg.id;
        players = msg.players;
    }
    else if (msg.type === "join") {
        players[msg.player.id] = msg.player;
    }
    else if (msg.type === "update") {
        players[msg.player.id] = msg.player;
    }
    else if (msg.type === "leave") {
        delete players[msg.id];
    }
});
function drawGrid() {
    const cellWidth = canvas.width / grid_width;
    const cellHeight = canvas.height / grid_length;
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= grid_width; i++) {
        ctx.moveTo(i * cellWidth, 0);
        ctx.lineTo(i * cellWidth, canvas.height);
    }
    for (let j = 0; j <= grid_length; j++) {
        ctx.moveTo(0, j * cellHeight);
        ctx.lineTo(canvas.width, j * cellHeight);
    }
    ctx.stroke();
}
document.addEventListener("keydown", (e) => {
    if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(e.key) !== -1) {
        socket.send(JSON.stringify({ type: "move", dir: keyToDir(e.key) }));
    }
});
document.getElementById("controls").addEventListener("click", (e) => {
    const target = e.target;
    if (target.tagName === "BUTTON") {
        const dir = target.id;
        socket.send(JSON.stringify({ type: "move", dir }));
    }
});
function keyToDir(key) {
    switch (key) {
        case "w":
        case "ArrowUp": return "up";
        case "s":
        case "ArrowDown": return "down";
        case "a":
        case "ArrowLeft": return "left";
        case "d":
        case "ArrowRight": return "right";
        default: return "";
    }
}
function gameLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    for (const id in players) {
        const p = players[id];
        ctx.fillStyle = id === myId ? "blue" : "red";
        ctx.fillRect(p.x, p.y, 20, 20);
    }
    requestAnimationFrame(gameLoop);
}
gameLoop();
