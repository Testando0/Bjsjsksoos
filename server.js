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

const db = new sqlite3.Database('./red_protocol_v20.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const online = {};

io.on('connection', (socket) => {
    socket.on('join', (u) => { socket.username = u; online[u] = socket.id; });
    
    socket.on('send_msg', (d) => {
        const target = online[d.r];
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", [d.s, d.r, d.c, d.type, target ? 1 : 0], function(err) {
            if (err) return;
            db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (err, row) => {
                if(target) io.to(target).emit('new_msg', row);
                socket.emit('msg_sent_ok', row);
            });
        });
    });

    socket.on('mark_read', (d) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [d.s, d.r], () => {
            if(online[d.s]) io.to(online[d.s]).emit('msgs_read', { by: d.r });
        });
    });
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).send();
    const h = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Red Protocol Active', '')", [username, h], (e) => e ? res.status(400).send() : res.json({ok:true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, u) => {
        if(u && await bcrypt.compare(req.body.password, u.password)) res.json(u); else res.status(401).send();
    });
});

app.get('/chats/:me', (req, res) => {
    const q = `SELECT DISTINCT contact, avatar, 
    (SELECT c FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_msg, 
    (SELECT status FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_status, 
    (SELECT strftime('%H:%M', time) FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_time, 
    (SELECT s FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_sender 
    FROM (SELECT r as contact FROM messages WHERE s=? UNION SELECT s as contact FROM messages WHERE r=?) JOIN users ON users.username = contact`;
    db.all(q, Array(10).fill(req.params.me), (err, rows) => res.json(rows || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e, r) => res.json(r || []));
});

app.get('/user/:u', (req, res) => db.get("SELECT * FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r)));
app.post('/update-profile', (req, res) => db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true})));
app.post('/post-status', (req, res) => db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.json({ok:true})));
app.get('/get-status', (req, res) => db.all("SELECT stories.*, users.avatar FROM stories JOIN users ON stories.username = users.username WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", (e, r) => res.json(r || [])));

server.listen(3001, () => console.log("Imperium V20 Online"));
