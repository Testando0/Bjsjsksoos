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

const db = new sqlite3.Database('./red_protocol_v12.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, type TEXT, content TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

const onlineUsers = {}; // Mapeamento Username -> SocketID

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        socket.username = username;
        onlineUsers[username] = socket.id;
        // Marca como entregue mensagens pendentes ao entrar
        db.run("UPDATE messages SET status = 1 WHERE r = ? AND status = 0", [username]);
        io.emit('user_status', { username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const { s, r, c, type } = data;
        const targetSocketId = onlineUsers[r];
        const initialStatus = targetSocketId ? 1 : 0;

        const query = "INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)";
        db.run(query, [s, r, c, type, initialStatus], function(err) {
            if (err) return;
            const msgId = this.lastID;
            
            db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [msgId], (err, row) => {
                if (row) {
                    // Envia para o destinatário se estiver online
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('new_msg', row);
                    }
                    // Confirmação para o remetente (Crucial para não "sumir")
                    socket.emit('msg_sent_ok', row);
                }
            });
        });
    });

    socket.on('mark_read', (d) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [d.s, d.r], () => {
            if (onlineUsers[d.s]) io.to(onlineUsers[d.s]).emit('msgs_read', { by: d.r });
        });
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            delete onlineUsers[socket.username];
            io.emit('user_status', { username: socket.username, status: 'offline' });
        }
    });
});

// Rotas de API
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Active', '')", [req.body.username, hash], (err) => err ? res.status(400).send() : res.json({ok:true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) res.json(user);
        else res.status(401).send();
    });
});

app.get('/chats/:me', (req, res) => {
    const query = `
        SELECT DISTINCT contact, avatar, 
        (SELECT c FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_msg,
        (SELECT status FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_status,
        (SELECT strftime('%H:%M', time) FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_time,
        (SELECT COUNT(*) FROM messages WHERE s=contact AND r=? AND status < 2) as unread
        FROM (SELECT r as contact FROM messages WHERE s=? UNION SELECT s as contact FROM messages WHERE r=?) 
        JOIN users ON users.username = contact`;
    db.all(query, Array(9).fill(req.params.me), (err, rows) => res.json(rows || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => res.json(rows || []));
});

app.get('/user/:u', (req, res) => db.get("SELECT * FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row)));

server.listen(3001, () => console.log("Protocol V12 Online"));
