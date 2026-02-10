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
    maxHttpBufferSize: 1e8 // Permite upload de imagens grandes (100mb)
}); 

// Aumentando limite do body parser para imagens em base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public')); 
app.use(cors());

// Banco de Dados
const db = new sqlite3.Database('./whatsapp_ultimate.db');

// --- INICIALIZAÇÃO DO BANCO ---
db.serialize(() => {
    // Usuários
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        avatar TEXT, 
        bio TEXT DEFAULT 'Disponível', 
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Mensagens (s=sender, r=receiver, c=content)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT, r TEXT, c TEXT, type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, -- 0: enviado, 1: recebido, 2: lido
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    // Stories
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, content TEXT, type TEXT DEFAULT 'image', 
        caption TEXT, bg_color TEXT, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    // Visualizações de Story
    db.run(`CREATE TABLE IF NOT EXISTS story_views (
        story_id INTEGER, viewer TEXT, 
        time DATETIME DEFAULT (datetime('now','localtime')), 
        PRIMARY KEY(story_id, viewer)
    )`);
    
    // Amigos (Sistema de Solicitação)
    // status: 0 (pendente), 1 (aceito)
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        u1 TEXT, u2 TEXT, status INTEGER DEFAULT 0, action_user TEXT, 
        PRIMARY KEY(u1, u2)
    )`);
});

// --- HELPER FUNCTIONS ---
const getChatPartner = (user, u1, u2) => (u1 === user ? u2 : u1);

// --- ROTAS DE AUTENTICAÇÃO (/auth) ---
// Frontend chama: /auth/register
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

// Frontend chama: /auth/login
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

// --- ROTAS DE USUÁRIO E AMIZADE ---

// Busca usuários para nova conversa
app.get('/api/search/:val', (req, res) => {
    const val = `%${req.params.val}%`;
    db.all("SELECT username, avatar FROM users WHERE username LIKE ? LIMIT 10", [val], (err, rows) => {
        res.json(rows || []);
    });
});

// Enviar Solicitação de Amizade
app.post('/api/friend-request', (req, res) => {
    const { from, to } = req.body;
    if(from === to) return res.status(400).json({error: "Erro"});

    // Ordena para manter consistência no banco (u1 sempre < u2 alfabeticamente)
    const [u1, u2] = [from, to].sort();

    db.get("SELECT * FROM friends WHERE u1=? AND u2=?", [u1, u2], (err, row) => {
        if(row) {
            // Se já existe e foi aceito (1) ou pendente (0), não faz nada
            return res.json({ status: row.status === 1 ? 'friends' : 'pending' });
        }
        db.run("INSERT INTO friends (u1, u2, status, action_user) VALUES (?, ?, 0, ?)", [u1, u2, from], (err) => {
            if(err) return res.status(500).json({error: "Erro DB"});
            res.json({ success: true });
        });
    });
});

// Listar Solicitações Pendentes (Onde o usuário NÃO foi quem enviou)
app.get('/api/friend-requests/:user', (req, res) => {
    const user = req.params.user;
    const q = `
        SELECT u.username, u.avatar 
        FROM friends f
        JOIN users u ON (
            (f.u1 = u.username AND f.u2 = ?) OR 
            (f.u2 = u.username AND f.u1 = ?)
        )
        WHERE f.status = 0 AND f.action_user != ?
    `;
    db.all(q, [user, user, user], (err, rows) => res.json(rows || []));
});

// Responder Solicitação
app.post('/api/respond-request', (req, res) => {
    const { me, friend, action } = req.body; // action: 'accept' ou 'reject'
    const [u1, u2] = [me, friend].sort();

    if(action === 'reject') {
        db.run("DELETE FROM friends WHERE u1=? AND u2=?", [u1, u2], () => res.json({success: true}));
    } else {
        db.run("UPDATE friends SET status = 1, action_user = ? WHERE u1=? AND u2=?", [me, u1, u2], () => res.json({success: true}));
    }
});

// Dados do Perfil
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

// --- ROTAS DE CHAT E MENSAGENS ---

// **CRÍTICO: Lista de Conversas (Estilo WhatsApp)**
app.get('/api/chats/:user', (req, res) => {
    const user = req.params.user;
    
    // Essa query é complexa: 
    // 1. Pega todas as mensagens onde o usuário é remetente ou destinatário.
    // 2. Agrupa pelo contato (parceiro de conversa).
    // 3. Pega a última mensagem e conta as não lidas.
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
        
        // Precisamos popular o avatar para cada contato manualmente pois o GROUP BY do SQLite é limitado para JOINs complexos num único passo
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

// Mensagens de uma conversa
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

// Pega stories do usuário + amigos (últimas 24h)
app.get('/api/stories/:user', (req, res) => {
    const user = req.params.user;
    // Pega stories meus OU de amigos
    // Simplificação: por enquanto pega todos nas ultimas 24h para demo, ou filtrar se necessário
    // Ideal: JOIN friends
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
let onlineUsers = {}; // Map: username -> socket.id

io.on('connection', (socket) => {
    
    socket.on('join', (username) => {
        onlineUsers[username] = socket.id;
        socket.join(username); // Cria sala com nome do usuario
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [username]);
        io.emit('contact_status_update', { username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        // data: { s: sender, r: receiver, c: content, type: 'text'/'image' }
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, 0)", 
        [data.s, data.r, data.c, data.type], function(err) {
            if(!err) {
                const msgPayload = { ...data, id: this.lastID, time: new Date(), status: 0 };
                
                // Envia para o destinatário se online
                if(onlineUsers[data.r]) {
                    io.to(onlineUsers[data.r]).emit('new_msg', msgPayload);
                }
                // (Opcional) Confirmação de envio para o remetente via socket não é estritamente necessária se o front já renderiza, 
                // mas podemos enviar um 'msg_sent' para atualizar ID ou status
            }
        });
    });

    socket.on('mark_read', (data) => {
        // data: { s: contato_que_mandou, r: eu_que_li }
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], () => {
            if(onlineUsers[data.s]) {
                io.to(onlineUsers[data.s]).emit('msgs_read_update', { by: data.r });
            }
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
        }
    });

    socket.on('delete_chat', (data) => {
        const { me, partner } = data;
        // Na vida real, seria apenas "esconder". Aqui vamos deletar fisicamente para simplificar a limpeza
        db.run("DELETE FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?)", [me, partner, partner, me]);
    });

    // Get Status (Online/Visto por ultimo) específico
    socket.on('get_status_detailed', (targetUser) => {
        db.get("SELECT last_seen FROM users WHERE username = ?", [targetUser], (err, row) => {
            if(row) {
                // Se estiver no map onlineUsers, força 'online', senão pega do banco
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
