const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); 

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public')); 
app.use(cors());

// --- MUDANÇA ESTRATÉGICA: Nome novo para forçar criação correta das tabelas ---
const db = new sqlite3.Database('./whatsapp_production.db');

// --- INICIALIZAÇÃO DE BANCO DE DADOS ROBUSTA ---
db.serialize(() => {
    // Tabelas Base
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT, last_seen DATETIME)");
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT, r TEXT, c TEXT, type TEXT, 
        status INTEGER DEFAULT 0, 
        is_deleted INTEGER DEFAULT 0, 
        visible_for_s INTEGER DEFAULT 1, 
        visible_for_r INTEGER DEFAULT 1, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, content TEXT, type TEXT DEFAULT 'image', 
        caption TEXT, bg_color TEXT, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run("CREATE TABLE IF NOT EXISTS story_views (story_id INTEGER, viewer TEXT, time DATETIME DEFAULT (datetime('now','localtime')), PRIMARY KEY(story_id, viewer))");
    
    // Tabela de Amigos (Corrigida Definitivamente)
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        u1 TEXT, 
        u2 TEXT, 
        status INTEGER DEFAULT 0, 
        action_user TEXT, 
        PRIMARY KEY(u1, u2)
    )`);
});

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
        if (password !== user.password) return res.status(401).json({ error: "Senha incorreta" }); // Em prod usar bcrypt
        
        // Atualiza status para online ao logar
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [username]);
        res.json(user);
    });
});

app.post('/api/signup', (req, res) => {
    const { username, password } = req.body;
    const avatar = `https://ui-avatars.com/api/?name=${username}&background=random&color=fff`;
    
    db.run("INSERT INTO users (username, password, avatar, last_seen) VALUES (?, ?, ?, 'online')", 
    [username, password, avatar], (err) => {
        if (err) return res.status(400).json({ error: "Usuário já existe" });
        res.json({ username, avatar });
    });
});

// --- SISTEMA DE AMIZADE (CORRIGIDO) ---
app.post('/api/add-friend', (req, res) => {
    const { from, to } = req.body;
    if (from === to) return res.json({ status: 'error', msg: 'Não pode adicionar a si mesmo' });

    // Verifica se já existe relação
    db.get("SELECT * FROM friends WHERE (u1=? AND u2=?) OR (u1=? AND u2=?)", [from, to, to, from], (err, row) => {
        if (row) {
            // Se já são amigos ou pendente
            if (row.status === 1) return res.json({ status: 'already_friends' });
            if (row.status === 0) return res.json({ status: 'pending' });
        } else {
            // Cria nova solicitação
            // Lógica: u1 é sempre alfabeticamente menor para consistência da chave primária
            const [first, second] = [from, to].sort();
            
            db.run("INSERT INTO friends (u1, u2, status, action_user) VALUES (?, ?, 0, ?)", 
            [first, second, from], 
            (err) => {
                if(err) {
                    console.error("Erro ao adicionar amigo:", err);
                    return res.status(500).json({error: "Erro no banco"});
                }
                res.json({ status: 'sent' });
            });
        }
    });
});

app.get('/api/friend-requests/:me', (req, res) => {
    const me = req.params.me;
    
    // Query Explicada:
    // Pega usuários (u) que estão na tabela friends comigo
    // ONDE (eu sou u1 OU eu sou u2)
    // E (quem fez a ação action_user NÃO fui eu)
    // E (status é 0 = pendente)
    const q = `
        SELECT u.username, u.avatar 
        FROM friends f 
        JOIN users u ON (
            (f.u1 = u.username AND f.u2 = ?) OR 
            (f.u2 = u.username AND f.u1 = ?)
        )
        WHERE f.action_user != ? 
        AND f.status = 0
    `;
    
    db.all(q, [me, me, me], (err, rows) => {
        if (err) {
            console.error("ERRO BUSCANDO SOLICITAÇÕES:", err);
            return res.json([]);
        }
        res.json(rows || []);
    });
});

app.post('/api/respond-request', (req, res) => {
    const { me, friend, action } = req.body;
    // Precisamos achar a linha onde 'me' e 'friend' estão, independente da ordem
    const status = action === 'accept' ? 1 : -1; // -1 para deletar ou rejeitar futuramente
    
    if (action === 'reject') {
        db.run("DELETE FROM friends WHERE (u1=? AND u2=?) OR (u1=? AND u2=?)", [me, friend, friend, me], (err) => {
            res.json({ success: true });
        });
    } else {
        db.run("UPDATE friends SET status = 1, action_user = ? WHERE (u1=? AND u2=?) OR (u1=? AND u2=?)", 
        [me, me, friend, friend, me], (err) => {
            if(err) console.error(err);
            res.json({ success: true });
        });
    }
});

app.get('/api/my-friends/:me', (req, res) => {
    const me = req.params.me;
    const q = `
        SELECT u.username, u.avatar, u.bio, u.last_seen 
        FROM friends f 
        JOIN users u ON ((f.u1 = u.username AND f.u2 = ?) OR (f.u2 = u.username AND f.u1 = ?))
        WHERE f.status = 1
    `;
    db.all(q, [me, me], (err, rows) => {
        res.json(rows || []);
    });
});

// --- RESTO DA API (MENSAGENS, USUÁRIOS, STORIES) ---
app.get('/api/user/:username', (req, res) => {
    db.get("SELECT username, avatar, bio, last_seen FROM users WHERE username = ?", [req.params.username], (err, row) => res.json(row || {}));
});

app.get('/api/search-users', (req, res) => {
    const term = `%${req.query.q}%`;
    db.all("SELECT username, avatar FROM users WHERE username LIKE ? LIMIT 20", [term], (err, rows) => res.json(rows));
});

app.get('/api/chat/:u1/:u2', (req, res) => {
    const { u1, u2 } = req.params;
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [u1, u2, u2, u1], (err, rows) => res.json(rows));
});

app.post('/api/upload-story', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    db.run("INSERT INTO stories (username, content, type, caption, bg_color) VALUES (?, ?, ?, ?, ?)", 
        [username, content, type, caption, bg_color], 
        function(err) { res.json({ success: !err }); }
    );
});

app.get('/api/stories', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time ASC", [], (err, rows) => res.json(rows));
});

// --- SOCKET.IO (REALTIME) ---
let onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('join', (user) => {
        onlineUsers[user] = socket.id;
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [user]);
        io.emit('user_status', { username: user, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const { s, r, c, type } = data;
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, 1)", [s, r, c, type], function(err) {
            const msgData = { ...data, id: this.lastID, time: new Date() };
            if (onlineUsers[r]) io.to(onlineUsers[r]).emit('receive_msg', msgData);
            socket.emit('receive_msg', msgData); // Confirmação local
        });
    });

    socket.on('disconnect', () => {
        const user = Object.keys(onlineUsers).find(key => onlineUsers[key] === socket.id);
        if (user) {
            delete onlineUsers[user];
            db.run("UPDATE users SET last_seen = datetime('now','localtime') WHERE username = ?", [user]);
            io.emit('user_status', { username: user, status: 'offline', last_seen: new Date() });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SERVIDOR RODANDO PRO EM: http://localhost:${PORT}`));
