const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
// Aumentei o buffer e adicionei pingTimeout para conexões instáveis
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 5e7,
    pingTimeout: 60000 
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// MUDANÇA CRÍTICA: Nome novo para forçar criação correta das tabelas
const db = new sqlite3.Database('./messenger_titanium.db');

// OTIMIZAÇÃO DE PERFORMANCE
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = NORMAL;");

db.serialize(() => {
    // Tabela Usuários
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    
    // Tabela Mensagens (Estrutura Unificada)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT, 
        r TEXT, 
        group_id INTEGER DEFAULT NULL, 
        c TEXT, 
        type TEXT, 
        status INTEGER DEFAULT 0, 
        sender_avatar TEXT,
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    // Tabela Feed
    db.run("CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY, username TEXT, content TEXT, caption TEXT, type TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");

    // Tabelas de Grupo
    db.run("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, avatar TEXT, owner TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, username TEXT, is_admin INTEGER DEFAULT 0, PRIMARY KEY(group_id, username))");
});

const online = {}; 

io.on('connection', (socket) => {
    // Log de conexão para debug
    console.log('Socket conectado:', socket.id);

    socket.on('join', (u) => { 
        socket.username = u; 
        online[u] = socket.id;
        // Reconectar aos grupos
        db.all("SELECT group_id FROM group_members WHERE username = ?", [u], (err, rows) => {
            if(rows) rows.forEach(row => socket.join(`group_${row.group_id}`));
        });
    });

    // --- MENSAGENS (Lógica Corrigida) ---
    socket.on('send_msg', (d) => {
        // Validação básica
        if(!d.s || !d.r || !d.c) return console.error("Dados incompletos na mensagem");

        db.get("SELECT avatar FROM users WHERE username = ?", [d.s], (e, u) => {
            const sAvatar = u ? u.avatar : '';
            
            if (d.isGroup) {
                // Mensagem de Grupo
                const stmt = db.prepare("INSERT INTO messages (s, group_id, c, type, status, sender_avatar, r) VALUES (?, ?, ?, ?, 1, ?, ?)");
                // Note: 'r' no DB para grupo fica como string do ID do grupo para facilitar buscas mistas, ou NULL.
                // Aqui salvamos d.r (ID do grupo) na coluna group_id E na coluna r para compatibilidade de busca
                stmt.run([d.s, d.r, d.c, d.type, sAvatar, d.r], function(err) {
                    if(err) return console.error("Erro SQL Grupo:", err.message);
                    
                    db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (e, row) => {
                        io.to(`group_${d.r}`).emit('new_msg', { ...row, isGroup: true });
                        socket.emit('msg_sent_ok', row); // Confirmação para quem enviou
                    });
                });
                stmt.finalize();

            } else {
                // Mensagem Privada
                const recipientSocketId = online[d.r];
                const st = recipientSocketId ? 1 : 0;
                
                const stmt = db.prepare("INSERT INTO messages (s, r, c, type, status, sender_avatar, group_id) VALUES (?, ?, ?, ?, ?, ?, NULL)");
                stmt.run([d.s, d.r, d.c, d.type, st, sAvatar], function(err) {
                    if(err) return console.error("Erro SQL Privado:", err.message);

                    db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (e, row) => {
                        if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
                        socket.emit('msg_sent_ok', row);
                    });
                });
                stmt.finalize();
            }
        });
    });

    socket.on('mark_read', d => {
        if(d.isGroup) return;
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [d.s, d.r], function(err) {
            if(!err && this.changes > 0 && online[d.s]) {
                io.to(online[d.s]).emit('msgs_read_update', { reader: d.r });
            }
        });
    });

    // --- WEBRTC SIGNALING (Voz) ---
    socket.on('call_user', (data) => {
        const socketId = online[data.userToCall];
        if(socketId) io.to(socketId).emit('call_incoming', { signal: data.signalData, from: data.from });
    });
    socket.on('answer_call', (data) => {
        const socketId = online[data.to];
        if(socketId) io.to(socketId).emit('call_accepted', data.signal);
    });
    socket.on('ice_candidate', (data) => {
        const socketId = online[data.to];
        if(socketId) io.to(socketId).emit('ice_candidate', data.candidate);
    });
    socket.on('end_call', (data) => {
        const socketId = online[data.to];
        if(socketId) io.to(socketId).emit('call_ended');
    });

    // --- GRUPOS ---
    socket.on('create_group', (data) => {
        db.run("INSERT INTO groups (name, description, avatar, owner) VALUES (?, 'Sem descrição', '', ?)", [data.name, data.owner], function(err) {
            if(!err) {
                const gid = this.lastID;
                const members = [...data.members, data.owner];
                const stmt = db.prepare("INSERT INTO group_members (group_id, username, is_admin) VALUES (?, ?, ?)");
                members.forEach(m => {
                    stmt.run(gid, m, m === data.owner ? 1 : 0);
                    if(online[m]) {
                        const s = io.sockets.sockets.get(online[m]);
                        if(s) s.join(`group_${gid}`);
                    }
                });
                stmt.finalize();
                io.emit('group_created', { id: gid, members });
            } else console.error("Erro criar grupo:", err);
        });
    });

    socket.on('disconnect', () => { if(socket.username) delete online[socket.username]; });
});

// --- ROTAS API ---
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
    const me = req.params.me;
    // Query Otimizada para buscar DMs e Grupos
    const dmsQuery = `
        SELECT u.username as contact, u.avatar, 
        m.c as last_msg, m.type as last_type, m.status as last_status, m.s as last_sender, strftime('%H:%M', m.time) as last_time,
        (SELECT COUNT(*) FROM messages WHERE s = u.username AND r = ? AND status < 2) as unread,
        0 as is_group
        FROM users u 
        JOIN messages m ON m.id = (SELECT id FROM messages WHERE (s = u.username AND r = ?) OR (s = ? AND r = u.username) ORDER BY time DESC LIMIT 1) 
        WHERE u.username != ?`;

    const groupsQuery = `
        SELECT g.id as contact, g.avatar, g.name as display_name,
        m.c as last_msg, m.type as last_type, 1 as last_status, m.s as last_sender, strftime('%H:%M', m.time) as last_time,
        0 as unread,
        1 as is_group
        FROM groups g
        JOIN group_members gm ON g.id = gm.group_id
        LEFT JOIN messages m ON m.id = (SELECT id FROM messages WHERE group_id = g.id ORDER BY time DESC LIMIT 1)
        WHERE gm.username = ?`;

    db.all(`${dmsQuery} UNION ALL ${groupsQuery} ORDER BY last_time DESC`, [me, me, me, me, me], (e, r) => res.json(r || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    // u2 pode ser Username (DM) ou ID (Grupo)
    // Verificamos se u2 é puramente numérico para assumir que é grupo, ou usamos uma flag se passássemos na query
    // Como nomes de usuário podem ter numeros, o ideal seria passar um query param ?isGroup=true, mas vamos tentar inferir pela tabela groups
    
    // Logica simplificada robusta: Tenta buscar como grupo primeiro se for numerico, senao busca DM
    // Mas para garantir, vamos assumir que o frontend sabe o que pede.
    
    // Se a requisição veio de um contexto de grupo (vamos assumir se u2 parecer ID numérico e existir na tab groups)
    // porem, usernames podem ser numeros. Vamos confiar que o frontend manda o ID certo.
    
    // ESTRATÉGIA SEGURA: Buscar ambos e unir é lento.
    // Vamos assumir: Se u2 for ID de grupo, retorna msgs de grupo.
    
    // Verifica se é numero (Grupo IDs são inteiros)
    if(/^\d+$/.test(req.params.u2)) {
         // Pode ser um grupo
         db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE group_id = ? ORDER BY time ASC", [req.params.u2], (e, r) => {
             if(r && r.length > 0) return res.json(r);
             // Se não achou msg de grupo, pode ser um user com nome de numero? Raro, mas fallback:
             db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e2, r2) => res.json(r2 || []));
         });
    } else {
         db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e, r) => res.json(r || []));
    }
});

app.get('/user/:u', (req, res) => db.get("SELECT username, avatar, bio FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {})));
app.get('/users-all', (req, res) => db.all("SELECT username, avatar FROM users", (e,r) => res.json(r||[])));
app.get('/group/:id', (req, res) => {
    db.get("SELECT * FROM groups WHERE id = ?", [req.params.id], (err, group) => {
        if(group) {
            db.all("SELECT username, is_admin FROM group_members WHERE group_id = ?", [req.params.id], (e, members) => {
                group.members = members;
                res.json(group);
            });
        } else res.json({});
    });
});
app.post('/update-profile', (req, res) => db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [req.body.bio, req.body.avatar, req.body.username], () => res.json({ok:true})));
app.post('/post-feed', (req, res) => db.run("INSERT INTO feed (username, content, caption, type) VALUES (?, ?, ?, ?)", [req.body.username, req.body.content, req.body.caption, req.body.type], () => res.json({ok:true})));
app.get('/get-feed', (req, res) => db.all("SELECT f.*, u.avatar as user_avatar FROM feed f JOIN users u ON f.username = u.username ORDER BY f.time DESC LIMIT 50", (e, r) => res.json(r || [])));

// Manifest PWA
app.get('/manifest.json', (req, res) => res.json({ "name": "Messenger Pro", "short_name": "Pro", "start_url": "/", "display": "standalone", "background_color": "#000000", "theme_color": "#000000", "icons": [{"src": "https://cdn-icons-png.flaticon.com/512/733/733585.png", "sizes": "512x512", "type": "image/png"}] }));
app.get('/sw.js', (req, res) => { res.set('Content-Type', 'application/javascript'); res.send(`self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));`); });

server.listen(3001, () => console.log('SERVIDOR RODANDO: Porta 3001 (Novo DB: messenger_titanium.db)'));
