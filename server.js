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
        return JSON.parse(data || '[]');
    } catch (error) {
        return [];
    }
};

const saveUsers = (users) => {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
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
});

// Rota principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoints API
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ ok: false, message: "Dados incompletos" });
    
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
    res.json({ ok: true });
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

app.get('/messages/:u1/:u2', (req, res) => {
    const { u1, u2 } = req.params;
    db.all("SELECT * FROM messages WHERE (s = ? AND r = ?) OR (s = ? AND r = ?) ORDER BY time ASC", [u1, u2, u2, u1], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

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
            return { ...row, avatar: u ? u.avatar : '', is_verified: u ? u.is_verified : false, is_online: u ? u.is_online : false };
        });
        res.json(enriched);
    });
});

app.post('/upload-avatar', (req, res) => {
    const { username, image } = req.body;
    if (!image || !username) return res.status(400).json({ ok: false });
    
    try {
        const base64Image = image.split(';base64,').pop();
        const ext = image.split(';')[0].split('/')[1];
        const fileName = `${username}_${Date.now()}.${ext}`;
        const filePath = path.join(__dirname, 'public/avatars', fileName);
        
        fs.writeFileSync(filePath, base64Image, { encoding: 'base64' });
        const avatarUrl = `/avatars/${fileName}`;
        
        const users = getUsers();
        const user = users.find(u => u.username === username);
        if (user) {
            user.avatar = avatarUrl;
            saveUsers(users);
        }
        res.json({ ok: true, avatar: avatarUrl });
    } catch (e) {
        res.status(500).json({ ok: false });
    }
});

app.post('/post-status', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    db.run("INSERT INTO stories (username, content, type, caption, bg_color) VALUES (?, ?, ?, ?, ?)", 
        [username, content, type, caption, bg_color], (err) => {
        if (err) return res.status(500).json({ ok: false });
        res.json({ ok: true });
    });
});

app.get('/get-status', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-1 day') ORDER BY time ASC", (err, rows) => {
        if (err) return res.status(500).json([]);
        const users = getUsers();
        const enriched = rows.map(row => {
            const u = users.find(user => user.username === row.username);
            return { ...row, avatar: u ? u.avatar : '', is_verified: u ? u.is_verified : false };
        });
        res.json(enriched);
    });
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
