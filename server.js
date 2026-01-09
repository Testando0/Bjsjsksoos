const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 5e7 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_v3.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const online = {}; 

// --- ROTAS PWA (APP NATIVO) ---
app.get('/manifest.json', (req, res) => {
    res.json({
        "name": "Chat V3",
        "short_name": "ChatV3",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#09090b",
        "theme_color": "#18181b",
        "icons": [
            {
                "src": "https://cdn-icons-png.flaticon.com/512/1041/1041916.png", 
                "sizes": "192x192",
                "type": "image/png"
            },
            {
                "src": "https://cdn-icons-png.flaticon.com/512/1041/1041916.png",
                "sizes": "512x512",
                "type": "image/png"
            }
        ]
    });
});

app.get('/sw.js', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.send(`
        self.addEventListener('install', (e) => {
            console.log('[Service Worker] Install');
            self.skipWaiting();
        });
        self.addEventListener('fetch', (e) => {
            // Apenas repassa a requisição (Network Only) para garantir tempo real
            e.respondWith(fetch(e.request));
        });
    `);
});

// --- SOCKET ---
io.on('connection', (socket) => {
    socket.on('join', (u) => { 
        socket.username = u; 
        online[u] = socket.id; 
    });

    socket.on('send_msg', (d) => {
        const recipientSocketId = online[d.r];
        const st = recipientSocketId ? 1 : 0;
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", [d.s, d.r, d.c, d.type, st], function(err) {
            if(!err) {
                db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (e, row) => {
                    if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
                    socket.emit('msg_sent_ok', row);
                });
            }
        });
    });

    socket.on('mark_read', d => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [d.s, d.r], function(err) {
            if(!err && this.changes > 0 && online[d.s]) {
                io.to(online[d.s]).emit('msgs_read_update', { reader: d.r });
            }
        });
    });
    
    socket.on('disconnect', () => { if(socket.username) delete online[socket.username]; });
});

// --- API ROTAS ---
app.post('/register', async (req, res) => {
    try {
        const h = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, '', '')", [req.body.username, h], (e) => {
            if(e) return res.status(400).json({error: "Erro"});
            res.json({ok: true});
        });
    } catch(e) { res.status(500).send(); }
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, u) => {
        if(u && await bcrypt.compare(req.body.password, u.password)) { delete u.password; res.json(u); } else res.status(401).send();
    });
});

app.get('/chats/:me', (req, res) => {
    const q = `SELECT u.username as contact, u.avatar, m.c as last_msg, m.type as last_type, m.status as last_status, m.s as last_sender, strftime('%H:%M', m.time) as last_time, (SELECT COUNT(*) FROM messages WHERE s = u.username AND r = ? AND status < 2) as unread FROM users u JOIN messages m ON m.id = (SELECT id FROM messages WHERE (s = u.username AND r = ?) OR (s = ? AND r = u.username) ORDER BY time DESC LIMIT 1) WHERE u.username != ? ORDER BY m.time DESC`;
    db.all(q, [req.params.me, req.params.me, req.params.me, req.params.me], (e, r) => res.json(r || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e, r) => res.json(r || []));
});

app.get('/user/:u', (req, res) => db.get("SELECT username, avatar, bio FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {})));
app.post('/update-profile', (req, res) => db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true})));
app.post('/post-status', (req, res) => db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.json({ok:true})));
app.get('/get-status', (req, res) => db.all("SELECT s.*, u.avatar FROM stories s JOIN users u ON s.username = u.username WHERE s.time > datetime('now', '-24 hours') ORDER BY s.time DESC", (e, r) => res.json(r || [])));

server.listen(3001, () => console.log('Servidor PWA ON: Porta 3001'));
