const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8 
}); 

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public')); 
app.use(cors());

// Banco de Dados
const db = new sqlite3.Database('./whatsapp_ultimate.db');

// --- INICIALIZAÇÃO DO BANCO ---
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        avatar TEXT, 
        bio TEXT DEFAULT 'Disponível', 
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT, r TEXT, c TEXT, type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, content TEXT, type TEXT DEFAULT 'image', 
        caption TEXT, bg_color TEXT, 
        time DATETIME DEFAULT (datetime('now','localtime'))
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS story_views (
        story_id INTEGER, viewer TEXT, time DATETIME DEFAULT (datetime('now','localtime'))
    )`);
});

const onlineUsers = {};

// --- ROTAS DE AUTH & USER ---
app.post('/auth/register', (req, res) => {
    const { username, password } = req.body;
    db.run("INSERT INTO users (username, password) VALUES (?,?)", [username, password], function(err) {
        if (err) return res.status(400).json({ error: "Usuário já existe" });
        res.json({ username });
    });
});

app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (!row) return res.status(401).json({ error: "Dados inválidos" });
        res.json(row);
    });
});

app.post('/api/update-profile', (req, res) => {
    const { username, avatar, bio } = req.body;
    db.run("UPDATE users SET avatar = ?, bio = ? WHERE username = ?", [avatar, bio, username], (err) => {
        res.json({ success: true });
    });
});

app.get('/api/user/:username', (req, res) => {
    db.get("SELECT username, avatar, bio, last_seen FROM users WHERE username = ?", [req.params.username], (err, row) => {
        res.json(row || {});
    });
});

app.get('/api/search/:query', (req, res) => {
    const q = `%${req.params.query}%`;
    db.all("SELECT username, avatar FROM users WHERE username LIKE ? LIMIT 10", [q], (err, rows) => {
        res.json(rows || []);
    });
});

// --- ROTAS DE CHAT ---
app.get('/api/chats/:username', (req, res) => {
    const u = req.params.username;
    const q = `
        SELECT 
            CASE WHEN s = ? THEN r ELSE s END as contact,
            c as last_msg, type as last_type, time as last_time, status as last_status, s as last_sender,
            (SELECT COUNT(*) FROM messages WHERE s = contact AND r = ? AND status != 2) as unread
        FROM messages 
        WHERE id IN (
            SELECT MAX(id) FROM messages WHERE s = ? OR r = ? GROUP BY CASE WHEN s = ? THEN r ELSE s END
        )
        ORDER BY time DESC
    `;
    db.all(q, [u, u, u, u, u], (err, rows) => {
        if(err) return res.json([]);
        
        const promises = rows.map(r => new Promise(resolve => {
            db.get("SELECT avatar FROM users WHERE username = ?", [r.contact], (e, uRow) => {
                r.avatar = uRow ? uRow.avatar : null;
                resolve(r);
            });
        }));
        
        Promise.all(promises).then(final => res.json(final));
    });
});

app.get('/api/messages/:me/:other', (req, res) => {
    const { me, other } = req.params;
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", 
    [me, other, other, me], (err, rows) => {
        res.json(rows || []);
    });
});

// --- ROTAS DE STORIES ---
app.post('/api/story', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    db.run("INSERT INTO stories (username, content, type, caption, bg_color) VALUES (?,?,?,?,?)", 
    [username, content, type, caption, bg_color], function(err) {
        res.json({ id: this.lastID });
    });
});

app.get('/api/stories/:username', (req, res) => {
    db.all(`
        SELECT s.*, u.avatar 
        FROM stories s 
        JOIN users u ON s.username = u.username 
        WHERE s.time > datetime('now', '-1 day') 
        ORDER BY s.time DESC
    `, [], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/view-story', (req, res) => {
    const { id, viewer } = req.body;
    db.get("SELECT * FROM story_views WHERE story_id = ? AND viewer = ?", [id, viewer], (err, row) => {
        if(!row) db.run("INSERT INTO story_views (story_id, viewer) VALUES (?,?)", [id, viewer]);
        res.json({ ok: true });
    });
});

app.get('/api/story-viewers/:id', (req, res) => {
    db.all("SELECT v.viewer as username, v.time, u.avatar FROM story_views v JOIN users u ON v.viewer = u.username WHERE v.story_id = ? ORDER BY v.time DESC", [req.params.id], (err, rows) => {
        res.json(rows || []);
    });
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    
    socket.on('join', (username) => {
        onlineUsers[username] = socket.id;
        db.run("UPDATE users SET last_seen = 'online' WHERE username = ?", [username]);
        io.emit('contact_status_update', { username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const { s, r, c, type } = data;
        db.run("INSERT INTO messages (s, r, c, type, status) VALUES (?, ?, ?, ?, 0)", [s, r, c, type], function(err) {
            const msg = { ...data, id: this.lastID, time: new Date(), status: 0 };
            if(onlineUsers[r]) {
                io.to(onlineUsers[r]).emit('new_msg', msg);
            }
        });
    });

    socket.on('mark_read', (data) => {
        const { s, r } = data;
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ?", [s, r], () => {
             if(onlineUsers[s]) io.to(onlineUsers[s]).emit('msgs_read_update', { by: r });
        });
    });

    socket.on('delete_chat', (data) => {
        const { me, partner } = data;
        db.run("DELETE FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?)", [me, partner, partner, me]);
    });

    socket.on('get_status_detailed', (targetUser) => {
        db.get("SELECT last_seen FROM users WHERE username = ?", [targetUser], (err, row) => {
            if(row) {
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
