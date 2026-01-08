const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_pro_v4.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    db.run("CREATE TABLE IF NOT EXISTS messages (s TEXT, r TEXT, c TEXT, type TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, type TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// --- AUTH & PROFILE ---
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar, last_seen) VALUES (?, ?, 'Protocolo Ativo', '', datetime('now'))", 
    [req.body.username, hash], (err) => err ? res.status(400).json({error: "User exists"}) : res.json({ok: true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).json({ error: "Fail" });
    });
});

app.post('/update-profile', (req, res) => {
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true}));
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, bio, avatar, last_seen FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row || {error: true}));
});

// --- STATUS (MÍDIA) ---
app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, type, content) VALUES (?, ?, ?)", [req.body.username, req.body.type, req.body.content], () => res.json({ok:true}));
});

app.get('/get-status', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", (err, rows) => res.json(rows || []));
});

// --- REALTIME ---
const online = new Map();
io.on('connection', (socket) => {
    socket.on('join', (u) => {
        socket.username = u;
        online.set(u, socket.id);
        db.run("UPDATE users SET last_seen = datetime('now') WHERE username = ?", [u]);
        io.emit('st_change', {u, s: 'online'});
    });

    socket.on('send_msg', (d) => {
        db.run("INSERT INTO messages (s, r, c, type) VALUES (?, ?, ?, ?)", [d.s, d.r, d.c, d.type]);
        if (online.has(d.r)) io.to(online.get(d.r)).emit('new_msg', d);
    });

    socket.on('disconnect', () => {
        if(socket.username) {
            online.delete(socket.username);
            const now = new Date().toISOString();
            db.run("UPDATE users SET last_seen = ? WHERE username = ?", [now, socket.username]);
            io.emit('st_change', {u: socket.username, s: now});
        }
    });
});

server.listen(process.env.PORT || 3001);
