const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Aumentei o buffer para permitir envio de Imagens e Videos via Socket/Http
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); // 100MB

app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

// Banco de Dados
const db = new sqlite3.Database('./red_v3.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    // Adicionado suporte a tipos diferentes na tabela messages
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const onlineUsers = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKET.IO (Real-time) ---
io.on('connection', (socket) => {
    socket.on('join', (username) => { 
        socket.username = username; 
        onlineUsers[username] = socket.id;
        io.emit('user_status', { username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        // data: { s: sender, r: receiver, c: content, type: 'text'|'audio'|'image'|'video' }
        const recipientSocketId = onlineUsers[data.r];
        const status = recipientSocketId ? 1 : 0; 

        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", 
            [data.s, data.r, data.c, data.type, status], 
            function(err) {
                if(!err) {
                    const msgId = this.lastID;
                    db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [msgId], (e, row) => {
                        // Envia para o destinatário imediatamente
                        if(recipientSocketId) {
                            io.to(recipientSocketId).emit('new_msg', row);
                        }
                        // Devolve para o remetente (para confirmar envio e pintar na tela se necessário)
                        socket.emit('msg_sent_ok', row);
                    });
                }
            }
        );
    });

    socket.on('mark_read', (data) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], function(err) {
            if(!err && this.changes > 0 && onlineUsers[data.s]) {
                io.to(onlineUsers[data.s]).emit('msgs_read_update', { reader: data.r });
            }
        });
    });

    socket.on('typing', (data) => {
        const dest = onlineUsers[data.to];
        if(dest) io.to(dest).emit('typing_status', { from: socket.username, isTyping: data.isTyping });
    });
    
    socket.on('disconnect', () => { 
        if(socket.username) delete onlineUsers[socket.username]; 
    });
});

// --- ROTAS API ---

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if(!username || !password) return res.status(400).json({error: "Dados inválidos"});
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Olá! Estou usando o Chat.', '')", [username, hash], (err) => {
            if(err) return res.status(400).json({error: "Usuário já existe"});
            res.json({ok: true});
        });
    } catch(e) { res.status(500).send(); }
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if(user && await bcrypt.compare(req.body.password, user.password)) { 
            delete user.password; 
            res.json(user); 
        } else {
            res.status(401).json({error: "Credenciais inválidas"});
        }
    });
});

app.get('/chats/:me', (req, res) => {
    const me = req.params.me;
    const query = `
        SELECT 
            u.username as contact, u.avatar, m.c as last_msg, m.type as last_type, m.status as last_status, m.s as last_sender, strftime('%H:%M', m.time) as last_time,
            (SELECT COUNT(*) FROM messages WHERE s = u.username AND r = ? AND status < 2) as unread
        FROM users u 
        JOIN messages m ON m.id = (
            SELECT id FROM messages WHERE (s = u.username AND r = ?) OR (s = ? AND r = u.username) ORDER BY id DESC LIMIT 1
        )
        WHERE u.username != ? ORDER BY m.time DESC
    `;
    db.all(query, [me, me, me, me], (err, rows) => res.json(rows || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY id ASC", 
        [req.params.u1, req.params.u2, req.params.u2, req.params.u1], 
        (err, rows) => res.json(rows || [])
    );
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, avatar, bio FROM users WHERE username = ?", [req.params.u], (err, row) => res.json(row || {}));
});

app.post('/update-profile', (req, res) => {
    const { bio, avatar, username } = req.body;
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [bio, avatar, username], () => res.json({ok:true}));
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.json({ok:true}));
});

app.get('/get-status', (req, res) => {
    db.all("SELECT s.*, u.avatar FROM stories s JOIN users u ON s.username = u.username WHERE s.time > datetime('now', '-24 hours') ORDER BY s.time DESC", (err, rows) => res.json(rows || []));
});

app.get('/manifest.json', (req, res) => res.json({
    "name": "WhatsApp iOS", "short_name": "Whats", "display": "standalone", "background_color": "#ffffff", "theme_color": "#f2f2f7",
    "icons": [{"src": "https://cdn-icons-png.flaticon.com/512/124/124034.png", "sizes": "192x192", "type": "image/png"}]
}));

server.listen(3001, () => console.log('Servidor OK porta 3001'));
