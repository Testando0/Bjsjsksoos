const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 5e7 // 50MB para fotos pesadas
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_v3.db');

// ESTRUTURA COMPLETA DO BANCO DE DADOS
db.serialize(() => {
    // Tabela de Usuários original
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    
    // Tabela de Mensagens com suporte a Status (Ticks) e Grupos
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, group_id INTEGER DEFAULT NULL, sender_avatar TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
    
    // Tabela de Stories (Status) original
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
    
    // Tabelas de Grupos novas
    db.run("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, avatar TEXT, owner TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, username TEXT, is_admin INTEGER DEFAULT 0)");
    
    // Tabela de Feed nova
    db.run("CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, caption TEXT, type TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const onlineUsers = {}; 

io.on('connection', (socket) => {
    console.log('Conexão detectada:', socket.id);

    socket.on('join', (username) => {
        socket.username = username;
        onlineUsers[username] = socket.id;
        
        // Avisa a todos que este usuário está ONLINE
        io.emit('user_status', { username: username, status: 'online' });
        
        // Coloca o socket nas salas dos grupos que ele pertence
        db.all("SELECT group_id FROM group_members WHERE username = ?", [username], (err, rows) => {
            if(rows) {
                rows.forEach(r => {
                    socket.join(`group_${r.group_id}`);
                    console.log(`${username} entrou na sala do grupo ${r.group_id}`);
                });
            }
        });
    });

    socket.on('send_msg', (data) => {
        const isGroup = !!data.isGroup;
        // Status 0: Enviado, Status 1: Recebido (se destinatário online), Status 2: Lido
        let initialStatus = 0;
        if (!isGroup && onlineUsers[data.r]) {
            initialStatus = 1; 
        } else if (isGroup) {
            initialStatus = 1;
        }

        const query = "INSERT INTO messages (s, r, c, type, status, group_id, sender_avatar) VALUES (?, ?, ?, ?, ?, ?, ?)";
        const params = [data.s, data.r, data.c, data.type, initialStatus, isGroup ? data.r : null, data.sender_avatar];

        db.run(query, params, function(err) {
            if (err) return console.error("Erro ao salvar mensagem:", err.message);
            
            const msgId = this.lastID;
            db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [msgId], (err, row) => {
                if (row) {
                    if (isGroup) {
                        // Envia para todos na sala do grupo
                        io.to(`group_${data.r}`).emit('new_msg', { ...row, isGroup: true });
                    } else {
                        // Envia para o remetente (confirmação)
                        socket.emit('new_msg', row);
                        // Envia para o destinatário se estiver online
                        if (onlineUsers[data.r]) {
                            io.to(onlineUsers[data.r]).emit('new_msg', row);
                        }
                    }
                }
            });
        });
    });

    socket.on('mark_read', (data) => {
        // Atualiza para status 2 (Lido) apenas se for mensagem direta
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2 AND group_id IS NULL", [data.contact, data.me], function(err) {
            if (this.changes > 0) {
                if (onlineUsers[data.contact]) {
                    io.to(onlineUsers[data.contact]).emit('msgs_read_update', { by: data.me });
                }
            }
        });
    });

    socket.on('create_group', (data) => {
        db.run("INSERT INTO groups (name, avatar, owner) VALUES (?, ?, ?)", [data.name, data.avatar || '', data.owner], function(err) {
            const groupId = this.lastID;
            const allMembers = [...data.members, data.owner];
            
            allMembers.forEach(member => {
                db.run("INSERT INTO group_members (group_id, username, is_admin) VALUES (?, ?, ?)", 
                    [groupId, member, member === data.owner ? 1 : 0], (err) => {
                    // Se o membro estiver online agora, faz ele dar join na sala
                    if (onlineUsers[member]) {
                        const memberSocket = io.sockets.sockets.get(onlineUsers[member]);
                        if (memberSocket) memberSocket.join(`group_${groupId}`);
                    }
                });
            });
            io.emit('refresh_chats');
        });
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            const userLoggedOut = socket.username;
            delete onlineUsers[userLoggedOut];
            // Avisa a todos que este usuário ficou OFFLINE
            io.emit('user_status', { username: userLoggedOut, status: 'offline' });
        }
    });
});

// --- ROTAS DE API (TUDO O QUE JÁ TINHA) ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (username, password, avatar, bio) VALUES (?, ?, '', '')", [username, hash], (err) => {
        if (err) return res.status(400).json({ error: "Usuário já existe" });
        res.json({ ok: true });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            res.json(user);
        } else {
            res.status(401).json({ error: "Credenciais inválidas" });
        }
    });
});

app.get('/chats/:me', (req, res) => {
    const me = req.params.me;
    // Query complexa para pegar a ÚLTIMA mensagem de cada chat (Pessoa ou Grupo) e contar não lidas
    const sql = `
        SELECT m.*, 
        CASE WHEN group_id IS NOT NULL THEN group_id ELSE (CASE WHEN s = ? THEN r ELSE s END) END as chat_id,
        CASE WHEN group_id IS NOT NULL THEN 1 ELSE 0 END as is_group,
        strftime('%H:%M', time) as f_time,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.s = (CASE WHEN m.s = ? THEN m.r ELSE m.s END) AND m2.r = ? AND m2.status < 2 AND m2.group_id IS NULL) as unread
        FROM messages m
        WHERE id IN (
            SELECT MAX(id) FROM messages 
            WHERE (s = ? OR r = ?) OR group_id IN (SELECT group_id FROM group_members WHERE username = ?)
            GROUP BY (CASE WHEN group_id IS NOT NULL THEN 'g'||group_id ELSE (CASE WHEN s = ? THEN r ELSE s END) END)
        ) ORDER BY id DESC`;

    db.all(sql, [me, me, me, me, me, me, me], async (err, rows) => {
        if (err) return res.json([]);
        const chats = await Promise.all(rows.map(async (row) => {
            if (row.is_group) {
                const groupInfo = await new Promise(resolve => db.get("SELECT name, avatar FROM groups WHERE id = ?", [row.chat_id], (e, r) => resolve(r)));
                row.display_name = groupInfo ? groupInfo.name : "Grupo";
                row.avatar = groupInfo ? groupInfo.avatar : "";
            } else {
                const userInfo = await new Promise(resolve => db.get("SELECT avatar FROM users WHERE username = ?", [row.chat_id], (e, r) => resolve(r)));
                row.display_name = row.chat_id;
                row.avatar = userInfo ? userInfo.avatar : "";
            }
            return row;
        }));
        res.json(chats);
    });
});

app.get('/messages/:me/:other', (req, res) => {
    const { me, other } = req.params;
    const isGroupChat = /^\d+$/.test(other); // Se for só números, é ID de grupo
    
    let query, params;
    if (isGroupChat) {
        query = "SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE group_id = ? ORDER BY time ASC";
        params = [other];
    } else {
        query = "SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=? AND group_id IS NULL) OR (s=? AND r=? AND group_id IS NULL) ORDER BY time ASC";
        params = [me, other, other, me];
    }
    db.all(query, params, (err, rows) => res.json(rows || []));
});

app.get('/users-all', (req, res) => {
    db.all("SELECT username, avatar, bio FROM users", (err, rows) => res.json(rows || []));
});

app.post('/update-profile', (req, res) => {
    const { username, avatar, bio } = req.body;
    db.run("UPDATE users SET avatar = ?, bio = ? WHERE username = ?", [avatar, bio, username], () => res.json({ ok: true }));
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.json({ ok: true }));
});

app.get('/get-status', (req, res) => {
    db.all("SELECT s.*, u.avatar FROM stories s JOIN users u ON s.username = u.username WHERE s.time > datetime('now', '-24 hours') ORDER BY s.time DESC", (err, rows) => res.json(rows || []));
});

app.post('/post-feed', (req, res) => {
    db.run("INSERT INTO feed (username, content, caption, type) VALUES (?, ?, ?, ?)", [req.body.username, req.body.content, req.body.caption || '', req.body.type || 'text'], () => res.json({ ok: true }));
});

app.get('/get-feed', (req, res) => {
    db.all("SELECT f.*, u.avatar as user_avatar FROM feed f JOIN users u ON f.username = u.username ORDER BY id DESC", (err, rows) => res.json(rows || []));
});

server.listen(3001, () => console.log("--- SERVIDOR TITANIUM RODANDO NA PORTA 3001 ---"));
