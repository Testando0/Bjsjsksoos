const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_final.db');

db.serialize(() => {
    // Usuários e Perfis
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    // Mensagens com vínculo de conversa
    db.run("CREATE TABLE IF NOT EXISTS messages (s TEXT, r TEXT, c TEXT, type TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
    // Status (Stories)
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// --- AUTH ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Protocolo Ativo', '')", [username, hash], (err) => {
        if (err) return res.status(400).json({ error: "User exists" });
        res.json({ ok: true });
    });
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).json({ error: "Fail" });
    });
});

// --- BUSCA E CONVERSAS ---
app.get('/search/:u', (req, res) => {
    db.get("SELECT username, avatar, bio FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row || {error: true}));
});

// Lista as últimas conversas do usuário (Tela Inicial)
app.get('/chats/:me', (req, res) => {
    const query = `SELECT DISTINCT CASE WHEN s = ? THEN r ELSE s END as contact FROM messages WHERE s = ? OR r = ? ORDER BY time DESC`;
    db.all(query, [req.params.me, req.params.me, req.params.me], (err, rows) => res.json(rows || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows || []));
});

// --- SOCKETS ---
const online = new Map();
io.on('connection', (socket) => {
    socket.on('join', (u) => { socket.username = u; online.set(u, socket.id); io.emit('st', {u, s: 'on'}); });
    socket.on('msg', (d) => {
        db.run("INSERT INTO messages (s, r, c, type) VALUES (?, ?, ?, ?)", [d.s, d.r, d.c, d.type]);
        if (online.has(d.r)) io.to(online.get(d.r)).emit('msg', d);
    });
    socket.on('disconnect', () => { if(socket.username) { online.delete(socket.username); io.emit('st', {u: socket.username, s: 'off'}); } });
});

server.listen(process.env.PORT || 3001);
