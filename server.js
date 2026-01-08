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

const db = new sqlite3.Database('./red_protocol_v11.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    // Adicionado coluna 'formatted_time' para facilitar o display
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, type TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar, last_seen) VALUES (?, ?, 'Secured Line', '', datetime('now'))", 
    [req.body.username, hash], (err) => err ? res.status(400).json({error: "User exists"}) : res.json({ok: true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).json({ error: "Fail" });
    });
});

app.get('/chats/:me', (req, res) => {
    const query = `
        SELECT DISTINCT contact, avatar, last_seen,
        (SELECT c FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_msg,
        (SELECT status FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_status,
        (SELECT strftime('%H:%M', time) FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_time,
        (SELECT COUNT(*) FROM messages WHERE s=contact AND r=? AND status < 2) as unread
        FROM (
            SELECT r as contact FROM messages WHERE s = ?
            UNION
            SELECT s as contact FROM messages WHERE r = ?
        ) JOIN users ON users.username = contact ORDER BY (SELECT time FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) DESC`;
    db.all(query, [req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me, req.params.me], (err, rows) => res.json(rows || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [req.params.u2, req.params.u1]);
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows || []));
});

// Outras rotas (status/perfil) mantidas conforme V10...
app.post('/update-profile', (req, res) => db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true})));
app.get('/user/:u', (req, res) => db.get("SELECT * FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row)));
app.post('/post-status', (req, res) => db.run("INSERT INTO stories (username, type, content) VALUES (?, ?, ?)", [req.body.username, req.body.type, req.body.content], () => res.json({ok:true})));
app.get('/get-status', (req, res) => db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", (err, rows) => res.json(rows || [])));

const online = {};
io.on('connection', (socket) => {
    socket.on('join', (u) => { socket.username = u; online[u] = socket.id; });
    socket.on('send_msg', (d) => {
        const s = online[d.r] ? 1 : 0;
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", [d.s, d.r, d.c, d.type, s], function() {
            db.get("SELECT strftime('%H:%M', 'now', 'localtime') as t", (err, row) => {
                const payload = { ...d, status: s, f_time: row.t };
                if (online[d.r]) io.to(online[d.r]).emit('new_msg', payload);
                socket.emit('msg_sent_ok', payload);
            });
        });
    });
    socket.on('mark_read', (d) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [d.s, d.r], () => {
            if (online[d.s]) io.to(online[d.s]).emit('msgs_read', { by: d.r });
        });
    });
});
server.listen(3001);
