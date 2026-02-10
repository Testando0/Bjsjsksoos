const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8 
}); 

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public')); 
app.use(cors());

// Banco de Dados
const db = new sqlite3.Database('./whatsapp_ultimate.db');

// --- INICIALIZAÇÃO DO BANCO ---
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        avatar TEXT, 
        bio TEXT DEFAULT 'Disponível', 
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT, r TEXT, c TEXT, type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, content TEXT, type TEXT DEFAULT 'image', 
        caption TEXT, bg_color TEXT, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS story_views (
        story_id INTEGER, viewer TEXT, 
        time DATETIME DEFAULT (datetime('now','localtime')), 
        PRIMARY KEY(story_id, viewer)
    )`);
    
    // NOME DA TABELA ALTERADO PARA 'friends_v2' PARA CORRIGIR ERROS DE VERSÃO
    db.run(`CREATE TABLE IF NOT EXISTS friends_v2 (
        u1 TEXT, u2 TEXT, status INTEGER DEFAULT 0, action_user TEXT, 
        PRIMARY KEY(u1, u2)
    )`);
});

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({error: "Dados inválidos"});

    const hashedPassword = await bcrypt.hash(password, 10);
    const avatar = `https://ui-avatars.com/api/?name=${username}&background=random&color=fff&size=256`;

    db.run("INSERT INTO users (username, password, avatar, last_seen) VALUES (?, ?, ?, 'online')", 
    [username, hashedPassword, avatar], (err) => {
        if (err) return res.status(400).json({ error: "Usuário já existe" });
        res.json({ username, avatar, bio: 'Disponível' });
    });
});

app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: "Senha incorreta" });
        
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [username]);
        res.json({ username: user.username, avatar: user.avatar, bio: user.bio });
    });
});

// --- ROTAS DE AMIZADE (Tabela friends_v2) ---
app.get('/api/search/:val', (req, res) => {
    const val = `%${req.params.val}%`;
    db.all("SELECT username, avatar FROM users WHERE username LIKE ? LIMIT 10", [val], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/friend-request', (req, res) => {
    const { from, to } = req.body;
    if(from === to) return res.status(400).json({error: "Erro"});

    const [u1, u2] = [from, to].sort();

    db.get("SELECT * FROM friends_v2 WHERE u1=? AND u2=?", [u1, u2], (err, row) => {
        if(row) return res.json({ status: row.status === 1 ? 'friends' : 'pending' });
        
        db.run("INSERT INTO friends_v2 (u1, u2, status, action_user) VALUES (?, ?, 0, ?)", [u1, u2, from], (err) => {
            if(err) { console.error(err); return res.status(500).json({error: "Erro DB"}); }
            res.json({ success: true });
        });
    });
});

app.get('/api/friend-requests/:user', (req, res) => {
    const user = req.params.user;
    // Traz solicitações onde status é 0 E eu NÃO fui quem mandou (action_user != eu)
    const q = `
        SELECT u.username, u.avatar 
        FROM friends_v2 f
        JOIN users u ON (
            (f.u1 = u.username AND f.u2 = ?) OR 
            (f.u2 = u.username AND f.u1 = ?)
        )
        WHERE f.status = 0 AND f.action_user != ?
    `;
    db.all(q, [user, user, user], (err, rows) => {
        if(err) console.error(err);
        res.json(rows || []);
    });
});

app.post('/api/respond-request', (req, res) => {
    const { me, friend, action } = req.body;
    const [u1, u2] = [me, friend].sort();

    if(action === 'reject') {
        db.run("DELETE FROM friends_v2 WHERE u1=? AND u2=?", [u1, u2], () => res.json({success: true}));
    } else {
        db.run("UPDATE friends_v2 SET status = 1, action_user = ? WHERE u1=? AND u2=?", [me, u1, u2], () => res.json({success: true}));
    }
});

// --- ROTAS DE PERFIL E CHAT ---
app.post('/api/update-profile', (req, res) => {
    const { username, avatar, bio } = req.body;
    db.run("UPDATE users SET avatar = ?, bio = ? WHERE username = ?", [avatar, bio, username], (err) => {
        res.json({success: !err});
    });
});

app.get('/api/user/:username', (req, res) => {
    db.get("SELECT username, avatar, bio, last_seen FROM users WHERE username = ?", [req.params.username], (err, row) => {
        res.json(row || {});
    });
});

app.get('/api/chats/:user', (req, res) => {
    const user = req.params.user;
    
    // Query complexa para pegar conversas baseadas nas MENSAGENS trocadas
    const query = `
        SELECT 
            CASE WHEN m.s = ? THEN m.r ELSE m.s END as contact,
            MAX(m.time) as last_time,
            m.c as last_msg,
            m.type as last_type,
            m.s as last_sender,
            m.status as last_status,
            (SELECT COUNT(*) FROM messages m2 WHERE m2.r = ? AND m2.s = (CASE WHEN m.s = ? THEN m.r ELSE m.s END) AND m2.status < 2) as unread
        FROM messages m
        WHERE m.s = ? OR m.r = ?
        GROUP BY contact
        ORDER BY last_time DESC
    `;

    db.all(query, [user, user, user, user, user], async (err, rows) => {
        if(err || !rows) return res.json([]);
        
        const enriched = await Promise.all(rows.map(async (row) => {
            return new Promise((resolve) => {
                db.get("SELECT avatar FROM users WHERE username = ?", [row.contact], (_, u) => {
                    row.avatar = u ? u.avatar : null;
                    resolve(row);
                });
            });
        }));
        
        res.json(enriched);
    });
});

app.get('/api/messages/:u1/:u2', (req, res) => {
    const { u1, u2 } = req.params;
    db.all(
        "SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", 
        [u1, u2, u2, u1], 
        (err, rows) => res.json(rows || [])
    );
});

// --- STORIES ---
app.post('/api/story', (req, res) => {
    const { username, content, caption } = req.body;
    db.run("INSERT INTO stories (username, content, caption) VALUES (?, ?, ?)", [username, content, caption], (err) => res.json({success: !err}));
});

app.get('/api/stories/:user', (req, res) => {
    const q = `
        SELECT s.*, u.avatar 
        FROM stories s 
        JOIN users u ON s.username = u.username
        WHERE s.time > datetime('now', '-24 hours') 
        ORDER BY s.time ASC
    `;
    db.all(q, [], (err, rows) => res.json(rows || []));
});

app.post('/api/view-story', (req, res) => {
    const { id, viewer } = req.body;
    db.run("INSERT OR IGNORE INTO story_views (story_id, viewer) VALUES (?, ?)", [id, viewer], () => res.json({ok:true}));
});

app.get('/api/story-viewers/:id', (req, res) => {
    db.all("SELECT v.viewer as username, v.time FROM story_views v WHERE v.story_id = ?", [req.params.id], (err, rows) => res.json(rows||[]));
});

// --- SOCKET.IO ---
let onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        onlineUsers[username] = socket.id;
        socket.join(username);
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [username]);
        io.emit('contact_status_update', { username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, 0)", 
        [data.s, data.r, data.c, data.type], function(err) {
            if(!err) {
                const msgPayload = { ...data, id: this.lastID, time: new Date(), status: 0 };
                if(onlineUsers[data.r]) io.to(onlineUsers[data.r]).emit('new_msg', msgPayload);
            }
        });
    });

    socket.on('mark_read', (data) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], () => {
            if(onlineUsers[data.s]) io.to(onlineUsers[data.s]).emit('msgs_read_update', { by: data.r });
        });
    });

    socket.on('send_friend_request', (data) => {
        if(onlineUsers[data.to]) {
            io.to(onlineUsers[data.to]).emit('new_friend_request', { from: data.from });
        }
    });
    
    socket.on('friend_request_accepted', (data) => {
        if(onlineUsers[data.to]) {
            io.to(onlineUsers[data.to]).emit('friend_request_accepted', {});
            // Opcional: Notificar quem aceitou também para atualizar lista
        }
    });

    socket.on('delete_chat', (data) => {
        const { me, partner } = data;
        db.run("DELETE FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?)", [me, partner, partner, me]);
    });

    socket.on('get_status_detailed', (targetUser) => {
        db.get("SELECT last_seen FROM users WHERE username = ?", [targetUser], (err, row) => {
            if(row) {
                const status = onlineUsers[targetUser] ? 'online' : row.last_seen;
                socket.emit('status_result', { username: targetUser, status, last_seen: row.last_seen });
            }
        });
    });

    socket.on('disconnect', () => {
        const user = Object.keys(onlineUsers).find(key => onlineUsers[key] === socket.id);
        if (user) {
            delete onlineUsers[user];
            const now = new Date().toISOString();
            db.run("UPDATE users SET last_seen = ? WHERE username = ?", [now, user]);
            io.emit('contact_status_update', { username: user, status: 'offline', last_seen: now });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SERVIDOR RODANDO EM: http://localhost:${PORT}`));
