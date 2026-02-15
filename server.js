const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100MB para suportar vídeos maiores
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('public'));

// Configuração de caminhos
const DATA_DIR = path.join(__dirname, 'data');
const AVATARS_DIR = path.join(__dirname, 'public', 'avatars');
const MEDIA_DIR = path.join(__dirname, 'public', 'media');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DB_FILE = path.join(__dirname, 'chat_database.db');

// Garantir que os diretórios existam
[DATA_DIR, AVATARS_DIR, MEDIA_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Banco de Dados SQLite
const db = new sqlite3.Database(DB_FILE);

// Funções de Gerenciamento de Usuários (JSON)
const getUsers = () => {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            const initialUsers = [{
                "username": "Redzin",
                "password": "$2a$10$FfwXxwrx5k.vrSpjTQkulOCFYkz80yKOGUdFtPkRkXmGXV95XjJB.", // senha: 123456
                "bio": "Olá! Estou usando a Rede Social Pro.",
                "avatar": "",
                "is_verified": true,
                "is_online": false,
                "last_seen": null
            }];
            fs.writeFileSync(USERS_FILE, JSON.stringify(initialUsers, null, 2));
            return initialUsers;
        }
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (error) {
        console.error('Erro ao ler usuários:', error);
        return [];
    }
};

const saveUsers = (users) => {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error('Erro ao salvar usuários:', error);
    }
};

// Inicialização do Banco de Dados
db.serialize(() => {
    // Tabela de Mensagens
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        s TEXT NOT NULL, 
        r TEXT NOT NULL, 
        c TEXT NOT NULL, 
        type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, 
        time DATETIME DEFAULT (datetime('now', 'localtime'))
    )`);
    
    // Tabela de Stories
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT NOT NULL, 
        content TEXT NOT NULL, 
        type TEXT DEFAULT 'image', 
        caption TEXT, 
        bg_color TEXT, 
        viewers TEXT DEFAULT '[]', 
        likes TEXT DEFAULT '[]',
        time DATETIME DEFAULT (datetime('now', 'localtime'))
    )`);
    
    // Índices para performance
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(s, r, time DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_stories_time ON stories(time DESC)");
});

// --- API ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Registro de Usuário
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ ok: false, message: "Preencha todos os campos" });
    
    const users = getUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ ok: false, message: "Este nome de usuário já está em uso" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            username,
            password: hashedPassword,
            bio: 'Olá! Estou usando a Rede Social Pro.',
            avatar: '',
            is_verified: false,
            is_online: false,
            last_seen: null
        };
        users.push(newUser);
        saveUsers(users);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, message: "Erro ao criar conta" });
    }
});

// Login de Usuário
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    if (user && await bcrypt.compare(password, user.password)) {
        const { password, ...userSafe } = user;
        res.json(userSafe);
    } else {
        res.status(401).json({ ok: false, message: "Usuário ou senha incorretos" });
    }
});

// Buscar dados de um usuário
app.get('/user/:username', (req, res) => {
    const users = getUsers();
    const user = users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (user) {
        const { password, ...userSafe } = user;
        res.json(userSafe);
    } else {
        res.status(404).json({ ok: false, message: "Usuário não encontrado" });
    }
});

// Atualizar Bio
app.post('/update-bio', (req, res) => {
    const { username, bio } = req.body;
    const users = getUsers();
    const userIndex = users.findIndex(u => u.username === username);
    if (userIndex !== -1) {
        users[userIndex].bio = bio;
        saveUsers(users);
        res.json({ ok: true });
    } else {
        res.status(404).json({ ok: false });
    }
});

// Upload de Avatar
app.post('/upload-avatar', (req, res) => {
    const { username, image } = req.body;
    if (!image || !username) return res.status(400).json({ ok: false });
    
    try {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const ext = image.split(';')[0].split('/')[1];
        const fileName = `${username}_${Date.now()}.${ext}`;
        const filePath = path.join(AVATARS_DIR, fileName);
        
        fs.writeFileSync(filePath, base64Data, 'base64');
        const avatarUrl = `/avatars/${fileName}`;
        
        const users = getUsers();
        const userIndex = users.findIndex(u => u.username === username);
        if (userIndex !== -1) {
            users[userIndex].avatar = avatarUrl;
            saveUsers(users);
            res.json({ ok: true, avatar: avatarUrl });
        } else {
            res.status(404).json({ ok: false });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false });
    }
});

// Listar conversas/chats
app.get('/chats/:username', (req, res) => {
    const { username } = req.params;
    const query = `
        SELECT 
            CASE WHEN s = ? THEN r ELSE s END as contact,
            c as last_msg,
            time as last_time,
            status as last_status,
            s as last_s,
            (SELECT COUNT(*) FROM messages WHERE r = ? AND s = contact AND status < 2) as unread
        FROM messages 
        WHERE id IN (
            SELECT MAX(id) FROM messages WHERE s = ? OR r = ? GROUP BY CASE WHEN s = ? THEN r ELSE s END
        )
        ORDER BY time DESC
    `;
    db.all(query, [username, username, username, username, username], (err, rows) => {
        if (err) return res.status(500).json([]);
        
        const users = getUsers();
        const enriched = rows.map(row => {
            const u = users.find(user => user.username === row.contact);
            return { 
                ...row, 
                avatar: u ? u.avatar : '', 
                is_verified: u ? u.is_verified : false, 
                is_online: u ? u.is_online : false 
            };
        });
        res.json(enriched);
    });
});

// Buscar mensagens de um chat
app.get('/messages/:u1/:u2', (req, res) => {
    const { u1, u2 } = req.params;
    db.all("SELECT * FROM messages WHERE (s = ? AND r = ?) OR (s = ? AND r = ?) ORDER BY time ASC", [u1, u2, u2, u1], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// Postar Status
app.post('/post-status', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    
    // Se for mídia base64, salvar como arquivo
    let finalContent = content;
    if (type !== 'text' && content.startsWith('data:')) {
        try {
            const base64Data = content.split(';base64,').pop();
            const ext = content.split(';')[0].split('/')[1];
            const fileName = `status_${username}_${Date.now()}.${ext}`;
            const filePath = path.join(MEDIA_DIR, fileName);
            fs.writeFileSync(filePath, base64Data, 'base64');
            finalContent = `/media/${fileName}`;
        } catch (e) {
            return res.status(500).json({ ok: false, message: "Erro ao salvar mídia" });
        }
    }

    db.run("INSERT INTO stories (username, content, type, caption, bg_color) VALUES (?, ?, ?, ?, ?)", 
        [username, finalContent, type, caption || '', bg_color || ''], (err) => {
        if (err) return res.status(500).json({ ok: false });
        res.json({ ok: true });
    });
});

// Buscar Status (últimas 24h)
app.get('/get-status', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-1 day', 'localtime') ORDER BY time ASC", (err, rows) => {
        if (err) return res.status(500).json([]);
        const users = getUsers();
        const enriched = rows.map(row => {
            const u = users.find(user => user.username === row.username);
            return { ...row, avatar: u ? u.avatar : '', is_verified: u ? u.is_verified : false };
        });
        res.json(enriched);
    });
});

// --- SOCKET.IO REAL-TIME ---

const onlineUsers = {};

io.on('connection', (socket) => {
    // Usuário entra online
    socket.on('go_online', (username) => {
        if (!username) return;
        socket.username = username; 
        onlineUsers[username] = socket.id;
        
        const users = getUsers();
        const user = users.find(u => u.username === username);
        if (user) {
            user.is_online = true;
            user.last_seen = null;
            saveUsers(users);
        }
        io.emit('user_status_change', { username, status: 'online' });
    });

    // Enviar mensagem
    socket.on('send_msg', (data) => {
        if (!data || !data.s || !data.r || !data.c) return;
        
        let finalContent = data.c;
        // Tratar mídia em mensagens
        if (data.type !== 'text' && data.c.startsWith('data:')) {
            try {
                const base64Data = data.c.split(';base64,').pop();
                const ext = data.c.split(';')[0].split('/')[1];
                const fileName = `chat_${Date.now()}.${ext}`;
                const filePath = path.join(MEDIA_DIR, fileName);
                fs.writeFileSync(filePath, base64Data, 'base64');
                finalContent = `/media/${fileName}`;
            } catch (e) { console.error(e); }
        }

        const recipientSocketId = onlineUsers[data.r];
        const status = recipientSocketId ? 1 : 0; 
        
        db.run(
            "INSERT INTO messages (s, r, c, type, status, time) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))", 
            [data.s, data.r, finalContent, data.type || 'text', status], 
            function(err) {
                if(err) return;
                const msgId = this.lastID;
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
                    if(e || !row) return;
                    if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
                    socket.emit('msg_sent_ok', row);
                    
                    // Notificar atualização de lista de chats
                    if(recipientSocketId) io.to(recipientSocketId).emit('update_chat_list');
                    socket.emit('update_chat_list');
                });
            }
        );
    });

    // Marcar como lido
    socket.on('mark_read', (data) => {
        if (!data || !data.s || !data.r) return;
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], () => {
            const senderSocket = onlineUsers[data.s];
            if (senderSocket) io.to(senderSocket).emit('msgs_read_update', { reader: data.r });
        });
    });

    // Visualizar Story
    socket.on('view_story', (data) => {
        if (!data || !data.storyId || !data.viewer) return;
        db.get("SELECT viewers FROM stories WHERE id = ?", [data.storyId], (err, row) => {
            if (err || !row) return;
            let viewers = JSON.parse(row.viewers || '[]');
            if (!viewers.includes(data.viewer)) {
                viewers.push(data.viewer);
                db.run("UPDATE stories SET viewers = ? WHERE id = ?", [JSON.stringify(viewers), data.storyId]);
            }
        });
    });

    // Curtir Story
    socket.on('like_story', (data) => {
        if (!data || !data.storyId || !data.username) return;
        db.get("SELECT likes FROM stories WHERE id = ?", [data.storyId], (err, row) => {
            if (err || !row) return;
            let likes = JSON.parse(row.likes || '[]');
            const index = likes.indexOf(data.username);
            if (index === -1) likes.push(data.username);
            else likes.splice(index, 1);
            db.run("UPDATE stories SET likes = ? WHERE id = ?", [JSON.stringify(likes), data.storyId], () => {
                io.emit('story_liked', { storyId: data.storyId, likes });
            });
        });
    });

    // Desconexão
    socket.on('disconnect', () => {
        if (socket.username) {
            const username = socket.username;
            delete onlineUsers[username];
            const users = getUsers();
            const user = users.find(u => u.username === username);
            if (user) {
                user.is_online = false;
                user.last_seen = new Date().toISOString();
                saveUsers(users);
                io.emit('user_status_change', { username, status: 'offline', last_seen: user.last_seen });
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Rede Social Perfeita rodando em http://localhost:${PORT}`);
});
