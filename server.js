const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Suporte para arquivos e fotos grandes
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_v3.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, bio TEXT, avatar TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (s TEXT, r TEXT, c TEXT, type TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

app.post('/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Sistema Ativo', '')", 
        [req.body.username, hash], (err) => err ? res.status(400).send("Erro") : res.send("OK"));
    } catch { res.status(500).send("Erro"); }
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).send("Falha");
    });
});

app.post('/update-profile', (req, res) => {
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.send("OK"));
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, bio, avatar FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row || {error: true}));
});

app.get('/stories', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", (err, rows) => res.json(rows));
});

app.post('/post-story', (req, res) => {
    db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.send("OK"));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows));
});

const onlineUsers = new Map();
io.on('connection', (socket) => {
    socket.on('join', (user) => {
        socket.username = user;
        onlineUsers.set(user, socket.id);
        io.emit('status_change', { user, status: 'online' });
    });
    socket.on('chat_msg', (data) => {
        db.run("INSERT INTO messages (s, r, c, type) VALUES (?, ?, ?, ?)", [data.s, data.r, data.c, data.type]);
        if (onlineUsers.has(data.r)) io.to(onlineUsers.get(data.r)).emit('new_msg', data);
    });
    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.delete(socket.username);
            io.emit('status_change', { user: socket.username, status: 'offline' });
        }
    });
});

server.listen(process.env.PORT || 3001, () => console.log("SISTEMA RED ONLINE"));
