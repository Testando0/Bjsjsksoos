const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
// Aumentado o buffer para permitir envio de imagens/áudios maiores sem travar
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8 
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_protocol_v22.db');

// Inicialização do Banco de Dados
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const online = {};

io.on('connection', (socket) => {
    socket.on('join', (u) => { 
        socket.username = u; 
        online[u] = socket.id; 
        // Notifica que o usuário está online (opcional, para futuro)
    });

    socket.on('send_msg', (d) => {
        const target = online[d.r];
        // Status: 0 = Enviado, 1 = Recebido (se online), 2 = Lido
        const initialStatus = target ? 1 : 0;
        
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, ?)", [d.s, d.r, d.c, d.type, initialStatus], function(err) {
            if (err) return console.error(err);
            
            // Busca a mensagem recém criada para devolver formatada
            db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (err, row) => {
                if (!row) return;
                
                // Envia para o destinatário se estiver online
                if(target) io.to(target).emit('new_msg', row);
                
                // Confirma envio para o remetente
                socket.emit('msg_sent_ok', row);
            });
        });
    });

    socket.on('mark_read', (d) => {
        // Marca como lido todas as mensagens recebidas daquele contato
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [d.s, d.r], () => {
            if(online[d.s]) io.to(online[d.s]).emit('msgs_read', { by: d.r });
        });
    });
});

// --- ROTAS API ---

app.post('/register', async (req, res) => {
    if(!req.body.username || !req.body.password) return res.status(400).json({error: "Dados incompletos"});
    try {
        const h = await bcrypt.hash(req.body.password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Disponível', '')", [req.body.username, h], (e) => {
            if(e) return res.status(400).json({error: "Usuário já existe"});
            res.json({ok: true});
        });
    } catch(e) { res.status(500).send(); }
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, u) => {
        if(u && await bcrypt.compare(req.body.password, u.password)) {
            // Remove a senha antes de enviar para o frontend
            delete u.password;
            res.json(u); 
        } else {
            res.status(401).send();
        }
    });
});

app.get('/chats/:me', (req, res) => {
    // Query complexa para pegar a última mensagem e contar não lidas
    const q = `
    SELECT DISTINCT contact, avatar, 
    (SELECT c FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_msg, 
    (SELECT type FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_type,
    (SELECT status FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_status, 
    (SELECT strftime('%H:%M', time) FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_time, 
    (SELECT s FROM messages WHERE (s=contact AND r=?) OR (s=? AND r=contact) ORDER BY time DESC LIMIT 1) as last_sender,
    (SELECT COUNT(*) FROM messages WHERE s=contact AND r=? AND status < 2) as unread
    FROM (SELECT r as contact FROM messages WHERE s=? UNION SELECT s as contact FROM messages WHERE r=?) 
    JOIN users ON users.username = contact`;
    
    // O array de parâmetros deve corresponder exatamente aos '?' na query
    const params = [
        req.params.me, req.params.me, // last_msg
        req.params.me, req.params.me, // last_type
        req.params.me, req.params.me, // last_status
        req.params.me, req.params.me, // last_time
        req.params.me, req.params.me, // last_sender
        req.params.me,                // unread count
        req.params.me, req.params.me  // subselect contacts
    ];

    db.all(q, params, (err, rows) => {
        if(err) console.error(err);
        res.json(rows || []);
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", 
        [req.params.u1, req.params.u2, req.params.u2, req.params.u1], 
        (e, r) => res.json(r || [])
    );
});

// FIX DE SEGURANÇA: Não retornar SELECT * (que inclui senha)
app.get('/user/:u', (req, res) => {
    db.get("SELECT username, avatar, bio FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {}));
});

app.post('/update-profile', (req, res) => {
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", 
        [req.body.bio, req.body.avatar, req.body.username], 
        () => res.json({ok:true})
    );
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, content) VALUES (?, ?)", 
        [req.body.username, req.body.content], 
        () => res.json({ok:true})
    );
});

app.get('/get-status', (req, res) => {
    db.all("SELECT stories.*, users.avatar FROM stories JOIN users ON stories.username = users.username WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", 
        (e, r) => res.json(r || [])
    );
});

server.listen(3001, () => {
    console.log('SERVIDOR RODANDO NA PORTA 3001');
});
