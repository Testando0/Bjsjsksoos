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

const db = new sqlite3.Database('./red_protocol_v7.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    // Status: 0 = Enviado, 1 = Entregue, 2 = Lido
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, type TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// --- API ---
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar, last_seen) VALUES (?, ?, 'Red Protocol Active', '', datetime('now'))", 
    [req.body.username, hash], (err) => err ? res.status(400).json({error: "User exists"}) : res.json({ok: true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).json({ error: "Fail" });
    });
});

// Rota de chats com contador de não lidas e status da última mensagem
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
    // Ao abrir o chat, marca todas como lidas (status 2)
    db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [req.params.u2, req.params.u1]);
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows || []));
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, bio, avatar, last_seen FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row || {error: true}));
});

// --- SOCKETS ---
const activeUsers = {};
io.on('connection', (socket) => {
    socket.on('join', (u) => {
        socket.username = u;
        activeUsers[u] = socket.id;
        // Ao conectar, marca mensagens enviadas para ele como "entregues" (status 1)
        db.run("UPDATE messages SET status = 1 WHERE r = ? AND status = 0", [u]);
        io.emit('st_up', { u, s: 'online' });
    });

    socket.on('send_msg', (d) => {
        const initialStatus = activeUsers[d.r] ? 1 : 0;
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", [d.s, d.r, d.c, d.type, initialStatus], function() {
            const msgId = this.lastID;
            if (activeUsers[d.r]) {
                io.to(activeUsers[d.r]).emit('new_msg', { ...d, id: msgId, status: initialStatus });
            }
            // Retorna ao remetente o ID e status inicial
            socket.emit('msg_sent_ok', { tempId: d.tempId, id: msgId, status: initialStatus });
        });
    });

    socket.on('mark_read', (d) => { // d.s (remetente das msgs), d.r (eu, que li)
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [d.s, d.r], () => {
            if (activeUsers[d.s]) io.to(activeUsers[d.s]).emit('msgs_read_by_target', { by: d.r });
        });
    });

    socket.on('disconnect', () => {
        if(socket.username) delete activeUsers[socket.username];
    });
});

server.listen(process.env.PORT || 3001);
