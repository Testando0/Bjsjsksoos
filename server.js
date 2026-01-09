const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
// Aumentei o buffer para 50MB para suportar áudios em base64 e imagens
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 5e7 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Conexão DB
const db = new sqlite3.Database('./red_protocol_v22.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    // Adicionada coluna 'type' se não existir (para versões antigas do DB, mas no create inicial já está lá)
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const online = {};

io.on('connection', (socket) => {
    socket.on('join', (u) => { 
        socket.username = u; 
        online[u] = socket.id; 
    });

    socket.on('send_msg', (d) => {
        const targetSocket = online[d.r];
        // Se o alvo está online, status inicial = 1 (entregue), senão 0 (enviado)
        // Se o usuário estiver COM O CHAT ABERTO, o frontend dele enviará 'mark_read' logo em seguida
        const initialStatus = targetSocket ? 1 : 0;

        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", 
        [d.s, d.r, d.c, d.type, initialStatus], function(err) {
            if(err) return console.error(err);
            
            db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (err, row) => {
                if(row) {
                    if(targetSocket) io.to(targetSocket).emit('new_msg', row);
                    socket.emit('msg_sent_ok', row);
                }
            });
        });
    });

    socket.on('mark_read', (d) => {
        // Marca como lido (2) todas as mensagens recebidas daquele remetente
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [d.s, d.r], function() {
            if(this.changes > 0 && online[d.s]) {
                io.to(online[d.s]).emit('msgs_read', { by: d.r });
            }
        });
    });

    socket.on('disconnect', () => {
        if(socket.username) delete online[socket.username];
    });
});

// --- ROTAS API ---

app.post('/register', async (req, res) => {
    try {
        const h = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Olá! Estou usando o Chat.', '')", 
        [req.body.username, h], (e) => {
            if(e) return res.status(400).json({error: "Usuário já existe"});
            res.json({ok: true});
        });
    } catch(e) { res.status(500).send(); }
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, u) => {
        if(u && await bcrypt.compare(req.body.password, u.password)) {
            delete u.password;
            res.json(u); 
        } else res.status(401).send();
    });
});

// Busca lista de contatos com última mensagem e info do usuário
app.get('/chats/:me', (req, res) => {
    const me = req.params.me;
    // Query otimizada para pegar a foto correta do contato
    const q = `
    SELECT 
        u.username as contact, 
        u.avatar, 
        m.c as last_msg,
        m.type as last_type,
        m.status as last_status,
        strftime('%H:%M', m.time) as last_time,
        m.s as last_sender,
        (SELECT COUNT(*) FROM messages WHERE s = u.username AND r = ? AND status < 2) as unread
    FROM users u
    JOIN messages m ON (m.id = (
        SELECT id FROM messages 
        WHERE (s = u.username AND r = ?) OR (s = ? AND r = u.username) 
        ORDER BY time DESC LIMIT 1
    ))
    WHERE u.username != ?
    ORDER BY m.time DESC`;
    
    db.all(q, [me, me, me, me], (err, rows) => {
        if(err) console.error(err);
        res.json(rows || []);
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", 
        [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (e, r) => res.json(r || []));
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, avatar, bio FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {}));
});

app.post('/update-profile', (req, res) => {
    const { username, bio, avatar } = req.body;
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [bio, avatar, username], (err) => {
        if(err) res.status(500).send();
        else res.json({ok:true});
    });
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.json({ok:true}));
});

app.get('/get-status', (req, res) => {
    // Join para pegar a foto do dono do status também
    db.all(`
        SELECT s.*, u.avatar 
        FROM stories s 
        JOIN users u ON s.username = u.username 
        WHERE s.time > datetime('now', '-24 hours') 
        ORDER BY s.time DESC`, 
    (e, r) => res.json(r || []));
});

server.listen(3001, () => console.log('Servidor rodando em http://localhost:3001'));
