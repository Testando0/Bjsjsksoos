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
    maxHttpBufferSize: 1e7 // 10MB
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Rota principal para servir o index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Banco de Dados SQLite
const db = new sqlite3.Database('chat_database.db');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

// Garantir pastas necessárias
if (!fs.existsSync('data')) fs.mkdirSync('data');
if (!fs.existsSync('public/avatars')) fs.mkdirSync('public/avatars', { recursive: true });

// Funções de Usuário (JSON)
const getUsers = () => {
    try {
        if (!fs.existsSync(USERS_FILE)) return [];
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(data || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error("Erro ao ler users.json, resetando para lista vazia:", error.message);
        fs.writeFileSync(USERS_FILE, '[]');
        return [];
    }
};

const saveUsers = (users) => {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error("Erro ao salvar users.json:", error.message);
    }
};

const isValidBase64Image = (str) => {
    if (!str || typeof str !== 'string') return false;
    return /^data:image\/(jpeg|jpg|png|gif|webp);base64,/.test(str);
};

const saveAvatarImage = (username, base64Data) => {
    if (!isValidBase64Image(base64Data)) return '';
    try {
        const base64Image = base64Data.split(';base64,').pop();
        const ext = base64Data.split(';')[0].split('/')[1];
        const fileName = `${username}_${Date.now()}.${ext}`;
        const filePath = path.join(__dirname, 'public/avatars', fileName);
        
        // Deletar avatar antigo se existir
        const users = getUsers();
        const user = users.find(u => u.username === username);
        if (user && user.avatar && user.avatar.startsWith('/avatars/')) {
            const oldPath = path.join(__dirname, 'public', user.avatar);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        fs.writeFileSync(filePath, base64Image, { encoding: 'base64' });
        return `/avatars/${fileName}`;
    } catch (e) {
        console.error("Erro ao salvar imagem:", e);
        return '';
    }
};

// Inicializar Banco de Dados
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        s TEXT NOT NULL, 
        r TEXT NOT NULL, 
        c TEXT NOT NULL, 
        type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, 
        time DATETIME DEFAULT (datetime('now'))
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT NOT NULL, 
        content TEXT NOT NULL, 
        type TEXT DEFAULT 'image', 
        caption TEXT, 
        bg_color TEXT, 
        viewers TEXT DEFAULT '[]', 
        likes TEXT DEFAULT '[]',
        time DATETIME DEFAULT (datetime('now'))
    )`);
    
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(s, r, time DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_stories_time ON stories(username, time DESC)");
});

// Endpoints API
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 4) {
        return res.status(400).json({ ok: false, message: "Dados inválidos" });
    }
    
    const users = getUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ ok: false, message: "Usuário já existe" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    users.push({
        username,
        password: hashedPassword,
        bio: 'Olá! Estou usando o Chat.',
        avatar: '',
        is_verified: false,
        is_online: false,
        last_seen: null
    });
    saveUsers(users);
    res.json({ ok: true, message: "Usuário criado com sucesso" });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    if (user && await bcrypt.compare(password, user.password)) {
        const { password, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
    } else {
        res.status(401).json({ ok: false, message: "Credenciais inválidas" });
    }
});

app.get('/user/:username', (req, res) => {
    const users = getUsers();
    const user = users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());
    if (user) {
        const { password, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
    } else {
        res.status(404).json({ ok: false });
    }
});

// Socket.IO
const onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('go_online', (username) => {
        if (!username) return;
        socket.username = username; 
        onlineUsers[username] = socket.id;
        
        let users = getUsers();
        let user = users.find(u => u.username === username);
        if (user) {
            user.is_online = true;
            user.last_seen = null;
            saveUsers(users);
        }
        io.emit('user_status_change', { username, status: 'online' });
        socket.emit('online_list', Object.keys(onlineUsers));
    });

    socket.on('send_msg', (data) => {
        if (!data || !data.s || !data.r || !data.c) return;
        const recipientSocketId = onlineUsers[data.r];
        const status = recipientSocketId ? 1 : 0; 
        
        db.run(
            "INSERT INTO messages (s, r, c, type, status, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
            [data.s, data.r, data.c, data.type || 'text', status], 
            function(err) {
                if(err) return;
                const msgId = this.lastID;
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
                    if(e || !row) return;
                    if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
                    socket.emit('msg_sent_ok', row);
                    if(recipientSocketId) io.to(recipientSocketId).emit('update_chat_list');
                    socket.emit('update_chat_list');
                });
            }
        );
    });

    socket.on('mark_read', (data) => {
        if (!data || !data.s || !data.r) return;
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], () => {
            const senderSocket = onlineUsers[data.s];
            if (senderSocket) io.to(senderSocket).emit('msgs_read_update', { reader: data.r });
        });
    });

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

    socket.on('disconnect', () => {
        if (socket.username) {
            const username = socket.username;
            delete onlineUsers[username];
            let users = getUsers();
            let user = users.find(u => u.username === username);
            if (user) {
                user.is_online = false;
                user.last_seen = new Date().toISOString();
                saveUsers(users);
            }
            io.emit('user_status_change', { username, status: 'offline', last_seen: user ? user.last_seen : null });
        }
    });
});

// Limpeza de stories antigos (>24h)
setInterval(() => {
    db.run("DELETE FROM stories WHERE time < datetime('now', '-1 day')");
}, 3600000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`✅ Socket.IO ativo e aguardando conexões`);
});
