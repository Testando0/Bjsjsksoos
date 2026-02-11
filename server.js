const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Aumentando buffer do Socket.IO para evitar corte de vídeos (100MB)
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8,
    pingTimeout: 60000 // Aumenta timeout para conexões lentas durante envio de video
}); 

// Limite do Express para JSON (Upload via API)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_v3.db');

// --- INICIALIZAÇÃO DO BANCO ---
db.serialize(() => {
    // Tabelas Base - Corrigido para salvar horário UTC (sem localtime)
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    
    // Time padrão agora é UTC
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now')))");
    
    // Stories também em UTC
    db.run("CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now')))");

    // Função auxiliar para atualização segura de colunas
    const addCol = (tbl, col, def) => {
        db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`, (err) => { /* Ignora erro se coluna já existe */ });
    };

    // Colunas extras
    addCol('users', 'last_seen', 'DATETIME');
    addCol('users', 'is_online', 'INTEGER DEFAULT 0');
    
    addCol('stories', 'type', 'TEXT DEFAULT "image"');
    addCol('stories', 'caption', 'TEXT');
    addCol('stories', 'bg_color', 'TEXT');
    addCol('stories', 'viewers', 'TEXT DEFAULT "[]"');
});

const onlineUsers = {}; // Cache: { username: socketId }

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKET ---
io.on('connection', (socket) => {
    
    socket.on('join', (username) => { 
        socket.username = username; 
        onlineUsers[username] = socket.id;
        
        // Atualiza status para Online
        db.run("UPDATE users SET is_online = 1 WHERE username = ?", [username]);
        
        // Emite status sem formatar data (envia objeto raw se necessário)
        io.emit('user_status_change', { username: username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const recipientSocketId = onlineUsers[data.r];
        const status = recipientSocketId ? 1 : 0; 

        // Insere usando horário UTC do banco
        db.run("INSERT INTO messages (s, r, c, type, status, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
            [data.s, data.r, data.c, data.type, status], 
            function(err) {
                if(!err) {
                    const msgId = this.lastID;
                    // Retorna a mensagem completa com o time cru (raw) para o front formatar
                    db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
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
    
    socket.on('view_status', (data) => {
        if(data.viewer === data.owner) return;

        db.get("SELECT viewers FROM stories WHERE id = ?", [data.story_id], (err, row) => {
            if(row) {
                let list = JSON.parse(row.viewers || "[]");
                if(!list.includes(data.viewer)) {
                    list.push(data.viewer);
                    db.run("UPDATE stories SET viewers = ? WHERE id = ?", [JSON.stringify(list), data.story_id], () => {
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
            // Salva last_seen em UTC
            db.run("UPDATE users SET is_online = 0, last_seen = datetime('now') WHERE username = ?", [socket.username]);
            // Envia evento
            io.emit('user_status_change', { username: socket.username, status: 'offline', last_seen: new Date().toISOString() });
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
    // Retorna last_time cru (sem strftime) para o front calcular fuso
    const q = `
        SELECT u.username as contact, u.avatar, u.is_online, 
        m.c as last_msg, m.type as last_type, m.status as last_status, m.s as last_sender, 
        m.time as last_time, 
        (SELECT COUNT(*) FROM messages WHERE s = u.username AND r = ? AND status < 2) as unread 
        FROM users u 
        JOIN messages m ON m.id = (SELECT id FROM messages WHERE (s = u.username AND r = ?) OR (s = ? AND r = u.username) ORDER BY id DESC LIMIT 1) 
        WHERE u.username != ? 
        ORDER BY m.time DESC`;
        
    db.all(q, [req.params.me, req.params.me, req.params.me, req.params.me], (e, r) => res.json(r || []));
});

app.get('/messages/:u1/:u2', (req, res) => {
    // Retorna time cru, sem formatar
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY id ASC", 
        [req.params.u1, req.params.u2, req.params.u2, req.params.u1], 
        (e, r) => res.json(r || [])
    );
});

app.get('/user/:u', (req, res) => {
    db.get("SELECT username, avatar, bio, is_online, last_seen FROM users WHERE username = ?", [req.params.u], (e, r) => res.json(r || {}));
});

app.post('/update-profile', (req, res) => {
    db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", 
        [req.body.bio, req.body.avatar, req.body.username], 
        () => res.json({ok:true})
    );
});

// --- POSTAR STATUS ---
app.post('/post-status', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    
    // Insere com UTC datetime('now')
    db.run("INSERT INTO stories (username, content, type, caption, bg_color, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
        [username, content, type || 'image', caption || '', bg_color || ''], 
        function(err) {
            if(err) return res.status(500).json({error: err.message});
            res.json({ok: true});
        }
    );
});

// --- OBTER STATUS ---
app.get('/get-status', (req, res) => {
    // Busca stories das últimas 24h (comparando UTC com UTC)
    const query = `
        SELECT s.*, u.avatar 
        FROM stories s 
        JOIN users u ON s.username = u.username 
        WHERE s.time > datetime('now', '-24 hours') 
        ORDER BY s.time ASC
    `;
    db.all(query, (e, rows) => {
        if(e) return res.json([]);
        
        const cleanRows = rows.map(r => ({
            ...r,
            viewers: JSON.parse(r.viewers || "[]")
        }));
        res.json(cleanRows);
    });
});

app.get('/story-viewers/:id', (req, res) => {
    db.get("SELECT viewers FROM stories WHERE id = ?", [req.params.id], (err, row) => {
        if(row) res.json(JSON.parse(row.viewers || "[]"));
        else res.json([]);
    });
});

server.listen(3001, () => console.log('Servidor iOS Clone ON port 3001'));