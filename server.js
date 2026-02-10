const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Buffer mantido alto para media
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); 

app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_v3.db');

// --- INICIALIZAÇÃO DO BANCO E MIGRAÇÃO SEGURA ---
db.serialize(() => {
    // Tabelas Base
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");

    // Migração de colunas novas (caso o banco já exista) - Safe Update
    const addCol = (tbl, col, def) => {
        db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`, (err) => { /* Ignora erro se coluna já existe */ });
    };

    // Novas colunas para User (Visto por último)
    addCol('users', 'last_seen', 'DATETIME');
    addCol('users', 'is_online', 'INTEGER DEFAULT 0'); // 0=off, 1=on

    // Novas colunas para Stories (Tipo, Legenda, Cor, Quem Viu)
    addCol('stories', 'type', 'TEXT DEFAULT "image"'); // image, video, text
    addCol('stories', 'caption', 'TEXT');
    addCol('stories', 'bg_color', 'TEXT'); // para status de texto
    addCol('stories', 'viewers', 'TEXT DEFAULT "[]"'); // JSON array de usernames
});

const onlineUsers = {}; // Cache de sockets: { username: socketId }

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKET ---
io.on('connection', (socket) => {
    
    socket.on('join', (username) => { 
        socket.username = username; 
        onlineUsers[username] = socket.id;
        
        // Atualiza DB para Online
        db.run("UPDATE users SET is_online = 1 WHERE username = ?", [username]);
        
        // Avisa a todos (para atualizar status nos cabeçalhos)
        io.emit('user_status_change', { username: username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const recipientSocketId = onlineUsers[data.r];
        const status = recipientSocketId ? 1 : 0; 

        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", 
            [data.s, data.r, data.c, data.type, status], 
            function(err) {
                if(!err) {
                    const msgId = this.lastID;
                    db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [msgId], (e, row) => {
                        if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
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
    
    // Novo evento para registrar visualização de Status em tempo real
    socket.on('view_status', (data) => {
        // data = { story_id, viewer, owner }
        if(data.viewer === data.owner) return; // Não conta visualização do próprio dono

        db.get("SELECT viewers FROM stories WHERE id = ?", [data.story_id], (err, row) => {
            if(row) {
                let list = JSON.parse(row.viewers || "[]");
                if(!list.includes(data.viewer)) {
                    list.push(data.viewer);
                    db.run("UPDATE stories SET viewers = ? WHERE id = ?", [JSON.stringify(list), data.story_id], () => {
                        // Opcional: Avisar o dono do status em tempo real se estiver online
                        const ownerSocket = onlineUsers[data.owner];
                        if(ownerSocket) io.to(ownerSocket).emit('status_viewed', { story_id: data.story_id, viewer: data.viewer });
                    });
                }
            }
        });
    });
    
    socket.on('disconnect', () => { 
        if(socket.username) {
            delete onlineUsers[socket.username];
            // Atualiza Visto Por Último
            db.run("UPDATE users SET is_online = 0, last_seen = datetime('now','localtime') WHERE username = ?", [socket.username]);
            io.emit('user_status_change', { username: socket.username, status: 'offline', last_seen: new Date() });
        }
    });
});

// --- API ---
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if(!username || !password) return res.status(400).json({error: "Erro"});
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Olá! Estou usando o Chat.', '')", [username, hash], (err) => {
            if(err) return res.status(400).json({error: "Existe"});
            res.json({ok: true});
        });
    } catch(e) { res.status(500).send(); }
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if(user && await bcrypt.compare(req.body.password, user.password)) { 
            delete user.password; 
            res.json(user); 
        } 
        else res.status(401).json({error: "Erro"});
    });
});

app.get('/chats/:me', (req, res) => {
    const q = `SELECT u.username as contact, u.avatar, u.is_online, m.c as last_msg, m.type as last_type, m.status as last_status, m.s as last_sender, strftime('%H:%M', m.time) as last_time, (SELECT COUNT(*) FROM messages WHERE s = u.username AND r = ? AND status < 2) as unread FROM users u JOIN messages m ON m.id = (SELECT id FROM messages WHERE (s = u.username AND r = ?) OR (s = ? AND r = u.username) ORDER BY id DESC LIMIT 1) WHERE u.username != ? ORDER BY m.time DESC`;
    db.all(q, [req.params.me, req.params.me, req.params.me, req.params.me], (e, r) => res.json(r || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY id ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e, r) => res.json(r || []));
});

// Endpoint User atualizado para retornar status
app.get('/user/:u', (req, res) => {
    db.get("SELECT username, avatar, bio, is_online, last_seen FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {}));
});

app.post('/update-profile', (req, res) => db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true})));

// --- POSTAR STATUS (Atualizado com Legenda e Texto) ---
app.post('/post-status', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    db.run("INSERT INTO stories (username, content, type, caption, bg_color) VALUES (?, ?, ?, ?, ?)", 
        [username, content, type || 'image', caption || '', bg_color || ''], 
        function(err) {
            if(err) return res.status(500).json({error: err.message});
            res.json({ok: true});
        }
    );
});

// --- OBTER STATUS (Agrupado por usuário com info de viewers) ---
app.get('/get-status', (req, res) => {
    // Busca stories das últimas 24h
    const query = `
        SELECT s.*, u.avatar 
        FROM stories s 
        JOIN users u ON s.username = u.username 
        WHERE s.time > datetime('now', '-24 hours') 
        ORDER BY s.time ASC
    `;
    db.all(query, (e, rows) => {
        if(e) return res.json([]);
        
        // Agrupar por usuário no backend ou frontend?
        // Vamos retornar a lista plana ordenada por tempo, o frontend agrupa.
        // Convertemos viewers JSON string para Objeto real
        const cleanRows = rows.map(r => ({
            ...r,
            viewers: JSON.parse(r.viewers || "[]")
        }));
        res.json(cleanRows);
    });
});

// --- QUEM VIU MEU STATUS ---
app.get('/story-viewers/:id', (req, res) => {
    db.get("SELECT viewers FROM stories WHERE id = ?", [req.params.id], (err, row) => {
        if(row) res.json(JSON.parse(row.viewers || "[]"));
        else res.json([]);
    });
});

server.listen(3001, () => console.log('Servidor iOS Clone ON port 3001'));
