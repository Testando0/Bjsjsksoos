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

const db = new sqlite3.Database('./red_protocol_final_v9.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, type TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// --- AUTH & PROFILE ---
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar, last_seen) VALUES (?, ?, 'Status: Ativo', '', datetime('now'))", 
    [req.body.username, hash], (err) => err ? res.status(400).json({error: "User exists"}) : res.json({ok: true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).json({ error: "Falha na autenticação" });
    });
});

app.post('/update-profile', (req, res) => {
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true}));
});

// --- CHATS, MSGS & STATUS ---
app.get('/chats/:me', (req, res) => {
    const query = `
        SELECT DISTINCT contact, avatar, last_seen,
        (SELECT c FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_msg,
        (SELECT status FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_status,
        (SELECT s FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_sender,
        (SELECT COUNT(*) FROM messages WHERE s=contact AND r=? AND status < 2) as unread
        FROM (
            SELECT r as contact FROM messages WHERE s = ?
            UNION
            SELECT s as contact FROM messages WHERE r = ?
        ) JOIN users ON users.username = contact`;
    db.all(query, [req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me], (err, rows) => res.json(rows || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [req.params.u2, req.params.u1]);
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows || []));
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, type, content) VALUES (?, ?, ?)", [req.body.username, req.body.type, req.body.content], () => res.json({ok:true}));
});

app.get('/get-status', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", (err, rows) => res.json(rows || []));
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, bio, avatar, last_seen FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row || {error: true}));
});

// --- REALTIME ---
const online = {};
io.on('connection', (socket) => {
    socket.on('join', (u) => {
        socket.username = u; online[u] = socket.id;
        db.run("UPDATE users SET last_seen = datetime('now') WHERE username = ?", [u]);
        db.run("UPDATE messages SET status = 1 WHERE r = ? AND status = 0", [u]);
    });
    socket.on('send_msg', (d) => {
        const s = online[d.r] ? 1 : 0;
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", [d.s, d.r, d.c, d.type, s], () => {
            if (online[d.r]) io.to(online[d.r]).emit('new_msg', { ...d, status: s });
            socket.emit('msg_sent_ok', { status: s });
        });
    });
    socket.on('mark_read', (d) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [d.s, d.r], () => {
            if (online[d.s]) io.to(online[d.s]).emit('msgs_read', { by: d.r });
        });
    });
    socket.on('disconnect', () => { if(socket.username) delete online[socket.username]; });
});

server.listen(process.env.PORT || 3001);
