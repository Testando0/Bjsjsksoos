const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); 

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public')); 

const db = new sqlite3.Database('./whatsapp_ios_pro.db');

// --- INICIALIZAÇÃO ---
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    // Adicionado 'visible_for_s' e 'visible_for_r' para gerenciar exclusão de chat sem perder histórico global
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0, visible_for_s INTEGER DEFAULT 1, visible_for_r INTEGER DEFAULT 1, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, type TEXT DEFAULT 'image', caption TEXT, bg_color TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS story_views (story_id INTEGER, viewer TEXT, time DATETIME DEFAULT (datetime('now','localtime')), PRIMARY KEY(story_id, viewer))");
    db.run("CREATE TABLE IF NOT EXISTS friends (u1 TEXT, u2 TEXT, status INTEGER DEFAULT 0, action_user TEXT, PRIMARY KEY(u1, u2))");
});

const onlineUsers = {}; 

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// --- SOCKET ---
io.on('connection', (socket) => {
    
    socket.on('join', (username) => { 
        socket.username = username; 
        onlineUsers[username] = socket.id;
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [username]);
        notifyFriendsStatus(username, 'online');
    });

    socket.on('send_msg', (data) => {
        const recipientSocketId = onlineUsers[data.r];
        // Status 1 (Entregue) apenas se o socket estiver ativo
        const status = recipientSocketId ? 1 : 0; 
        const now = new Date().toISOString();

        // Insere mensagem garantindo visibilidade para ambos
        db.run("INSERT INTO messages (s, r, c, type, status, time, visible_for_s, visible_for_r) VALUES (?, ?, ?, ?, ?, ?, 1, 1)", 
            [data.s, data.r, data.c, data.type, status, now], 
            function(err) {
                if(!err) {
                    const msgPayload = { ...data, id: this.lastID, status, time: now };
                    if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', msgPayload);
                    socket.emit('msg_sent_ok', msgPayload);
                }
            }
        );
    });

    socket.on('mark_read', (data) => {
        // Só marca lido se o remetente (s) ainda estiver online para receber o aviso? 
        // Não, marcamos no banco de qualquer forma.
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], function(err) {
            if(!err && this.changes > 0) {
                // Avisa o remetente que a mensagem foi lida
                if(onlineUsers[data.s]) {
                    io.to(onlineUsers[data.s]).emit('msgs_read_update', { reader: data.r });
                }
            }
        });
    });

    // Apagar chat inteiro (Esconder histórico para mim)
    socket.on('delete_chat', (data) => {
        const { me, partner } = data;
        // Se eu sou o remetente (s), seto visible_for_s = 0. Se sou receptor (r), visible_for_r = 0.
        db.run("UPDATE messages SET visible_for_s = 0 WHERE s = ? AND r = ?", [me, partner]);
        db.run("UPDATE messages SET visible_for_r = 0 WHERE r = ? AND s = ?", [me, partner]);
        socket.emit('chat_deleted_ok', { partner });
    });

    socket.on('typing', (data) => {
        const dest = onlineUsers[data.to];
        if(dest) io.to(dest).emit('typing_status', { from: socket.username, isTyping: data.isTyping });
    });

    socket.on('get_status_detailed', (targetUser) => {
        if (onlineUsers[targetUser]) {
            socket.emit('status_result', { username: targetUser, status: 'online' });
        } else {
            db.get("SELECT last_seen FROM users WHERE username = ?", [targetUser], (err, row) => {
                socket.emit('status_result', { username: targetUser, status: 'offline', last_seen: row ? row.last_seen : null });
            });
        }
    });

    socket.on('send_friend_request', (data) => {
        const { from, to } = data;
        if(onlineUsers[to]) io.to(onlineUsers[to]).emit('friend_request_received', { from });
    });

    socket.on('disconnect', () => { 
        if(socket.username) {
            const now = new Date().toISOString();
            db.run("UPDATE users SET last_seen = ? WHERE username = ?", [now, socket.username]);
            notifyFriendsStatus(socket.username, 'offline', now);
            delete onlineUsers[socket.username]; 
        }
    });
});

function notifyFriendsStatus(username, status, lastSeen = null) {
    db.all("SELECT u1, u2 FROM friends WHERE (u1 = ? OR u2 = ?) AND status = 1", [username, username], (err, rows) => {
        if(rows) {
            rows.forEach(r => {
                const friend = r.u1 === username ? r.u2 : r.u1;
                if(onlineUsers[friend]) {
                    io.to(onlineUsers[friend]).emit('contact_status_update', { username, status, last_seen: lastSeen });
                }
            });
        }
    });
}

// --- API ---

// Auth
app.post('/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar, last_seen) VALUES (?, ?, 'Olá! Estou usando o Chat.', '', ?)", 
        [username, hash, new Date().toISOString()], (err) => {
            if(err) return res.status(400).json({error: "Usuário já existe"});
            res.json({ok: true});
        });
    } catch(e) { res.status(500).send(); }
});

app.post('/auth/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if(user && await bcrypt.compare(req.body.password, user.password)) { 
            delete user.password; res.json(user); 
        } else res.status(401).json({error: "Credenciais inválidas"});
    });
});

// Chats: Apenas chats visíveis com mensagens
app.get('/api/chats/:me', (req, res) => {
    const me = req.params.me;
    const q = `
        SELECT 
            contact_name as contact,
            u.avatar,
            m.c as last_msg,
            m.type as last_type,
            m.status as last_status,
            m.s as last_sender,
            m.time as last_time,
            (SELECT COUNT(*) FROM messages 
             WHERE s = contact_name AND r = ? AND status < 2 AND visible_for_r = 1) as unread
        FROM (
            SELECT DISTINCT CASE WHEN s = ? THEN r ELSE s END as contact_name
            FROM messages 
            WHERE (s = ? AND visible_for_s = 1) OR (r = ? AND visible_for_r = 1)
        ) as contacts
        JOIN users u ON u.username = contacts.contact_name
        LEFT JOIN messages m ON m.id = (
            SELECT id FROM messages 
            WHERE ((s = ? AND r = u.username AND visible_for_s = 1) 
               OR (s = u.username AND r = ? AND visible_for_r = 1))
            ORDER BY time DESC LIMIT 1
        )
        ORDER BY m.time DESC
    `;
    db.all(q, [me, me, me, me, me, me], (e, r) => res.json(r || []));
});

// Mensagens: Apenas visíveis
app.get('/api/messages/:u1/:u2', (req, res) => {
    const { u1, u2 } = req.params; // u1 = requester (me), u2 = partner
    const q = `
        SELECT * FROM messages 
        WHERE ((s=? AND r=? AND visible_for_s=1) OR (s=? AND r=? AND visible_for_r=1))
        ORDER BY time ASC
    `;
    db.all(q, [u1, u2, u2, u1], (e, r) => res.json(r || []));
});

app.get('/api/user/:u', (req, res) => db.get("SELECT username, avatar, bio, last_seen FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {})));
app.post('/api/update-profile', (req, res) => db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true})));

// --- STORIES (CORRIGIDO: Apenas Amigos Aceitos) ---
app.post('/api/story', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    db.run("INSERT INTO stories (username, content, type, caption, bg_color) VALUES (?, ?, ?, ?, ?)", [username, content, type, caption, bg_color], () => res.json({ok:true}));
});

app.get('/api/stories/:me', (req, res) => {
    const me = req.params.me;
    // Seleciona stories do próprio usuário OU de amigos com status=1
    const q = `
        SELECT s.*, u.avatar 
        FROM stories s 
        JOIN users u ON s.username = u.username
        LEFT JOIN friends f ON (f.u1 = ? AND f.u2 = s.username) OR (f.u1 = s.username AND f.u2 = ?)
        WHERE (s.username = ? OR f.status = 1) 
        AND s.time > datetime('now', '-24 hours') 
        ORDER BY s.time ASC
    `;
    db.all(q, [me, me, me], (e, r) => res.json(r || []));
});

app.post('/api/view-story', (req, res) => {
    db.run("INSERT OR IGNORE INTO story_views (story_id, viewer) VALUES (?, ?)", [req.body.id, req.body.viewer], () => res.json({ok:true}));
});

app.get('/api/story-viewers/:id', (req, res) => {
    db.all("SELECT v.time, u.username, u.avatar FROM story_views v JOIN users u ON v.viewer = u.username WHERE v.story_id = ? ORDER BY v.time DESC", [req.params.id], (e, r) => res.json(r||[]));
});

// --- AMIZADES ---
app.get('/api/search/:term', (req, res) => {
    db.all("SELECT username, avatar, bio FROM users WHERE username LIKE ? LIMIT 10", [`%${req.params.term}%`], (e, r) => res.json(r||[]));
});

app.post('/api/friend-request', (req, res) => {
    const { from, to } = req.body;
    if(from === to) return res.status(400).json({});
    db.get("SELECT * FROM friends WHERE (u1=? AND u2=?) OR (u1=? AND u2=?)", [from, to, to, from], (err, row) => {
        if(row) {
             if(row.status === 1) return res.json({status: 'friends'});
             return res.json({status: 'pending'});
        } else {
            db.run("INSERT INTO friends (u1, u2, status, action_user) VALUES (?, ?, 0, ?)", [from, to, from], () => res.json({status: 'sent'}));
        }
    });
});

app.get('/api/friend-requests/:me', (req, res) => {
    const q = `
        SELECT u.username, u.avatar 
        FROM friends f 
        JOIN users u ON (f.u1 = u.username OR f.u2 = u.username) 
        WHERE ((f.u1 = ? AND f.action_user != ?) OR (f.u2 = ? AND f.action_user != ?)) 
        AND f.status = 0 AND u.username != ?
    `;
    db.all(q, [req.params.me, req.params.me, req.params.me, req.params.me, req.params.me], (e, r) => res.json(r || []));
});

app.post('/api/respond-request', (req, res) => {
    const { me, friend, action } = req.body;
    if(action === 'reject') {
        db.run("DELETE FROM friends WHERE (u1=? AND u2=?) OR (u1=? AND u2=?)", [me, friend, friend, me], ()=>res.json({ok:true}));
    } else {
        db.run("UPDATE friends SET status = 1 WHERE ((u1=? AND u2=?) OR (u1=? AND u2=?))", [me, friend, friend, me], ()=>res.json({ok:true}));
    }
});

server.listen(3001, () => console.log('Servidor 3001 - iOS Clone Pro'));
