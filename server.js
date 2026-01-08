const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_final_v5.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    db.run("CREATE TABLE IF NOT EXISTS messages (s TEXT, r TEXT, c TEXT, type TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, type TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// Auth
app.post('/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar, last_seen) VALUES (?, ?, 'Protocolo Ativo', '', datetime('now'))", 
        [req.body.username, hash], (err) => err ? res.status(400).json({error: "User exists"}) : res.json({ok: true}));
    } catch(e) { res.status(500).send(e); }
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

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows || []));
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, type, content) VALUES (?, ?, ?)", [req.body.username, req.body.type, req.body.content], () => res.json({ok:true}));
});

app.get('/get-status', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", (err, rows) => res.json(rows || []));
});

// Realtime Engine
const usersOnline = {}; 

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        socket.username = username;
        usersOnline[username] = socket.id;
        db.run("UPDATE users SET last_seen = datetime('now') WHERE username = ?", [username]);
        io.emit('user_status', { username, status: 'online' });
        console.log(`> ${username} conectado`);
    });

    socket.on('chat_message', (data) => {
        // Salva no banco primeiro
        db.run("INSERT INTO messages (s, r, c, type) VALUES (?, ?, ?, ?)", [data.s, data.r, data.c, data.type], () => {
            // Entrega em tempo real se o alvo estiver online
            const targetSocket = usersOnline[data.r];
            if (targetSocket) {
                io.to(targetSocket).emit('new_message', data);
            }
        });
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            delete usersOnline[socket.username];
            const now = new Date().toISOString();
            db.run("UPDATE users SET last_seen = ? WHERE username = ?", [now, socket.username]);
            io.emit('user_status', { username: socket.username, status: now });
        }
    });
});

server.listen(process.env.PORT || 3001, () => console.log("SERVER RED V5 ONLINE"));
