const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 5e7 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const db = new sqlite3.Database('./red_v3.db');

db.serialize(() => {
    // TODAS AS TABELAS ORIGINAIS + EXTRAS DE GRUPO
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, avatar TEXT, bio TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, group_id INTEGER DEFAULT NULL, sender_avatar TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (username TEXT, content TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
    db.run("CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, avatar TEXT, owner TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, username TEXT, is_admin INTEGER DEFAULT 0)");
    db.run("CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY, username TEXT, content TEXT, caption TEXT, type TEXT, time DATETIME DEFAULT (datetime('now','localtime')))");
});

const onlineUsers = {}; 

io.on('connection', (socket) => {
    socket.on('join', (u) => {
        socket.username = u;
        onlineUsers[u] = socket.id;
        io.emit('user_status', { username: u, status: 'online' }); // Alerta geral de Online
        
        // Entrar nas salas de grupos automaticamente
        db.all("SELECT group_id FROM group_members WHERE username = ?", [u], (err, rows) => {
            if(rows) rows.forEach(r => socket.join(`group_${r.group_id}`));
        });
    });

    socket.on('send_msg', (d) => {
        const isGroup = !!d.isGroup;
        const status = isGroup ? 1 : (onlineUsers[d.r] ? 1 : 0);
        
        db.run("INSERT INTO messages (s, r, c, type, status, group_id, sender_avatar) VALUES (?, ?, ?, ?, ?, ?, ?)", 
        [d.s, d.r, d.c, d.type, status, isGroup ? d.r : null, d.sender_avatar], function(err) {
            db.get("SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE id = ?", [this.lastID], (e, msg) => {
                if(isGroup) {
                    io.to(`group_${d.r}`).emit('new_msg', msg);
                } else {
                    socket.emit('new_msg', msg);
                    if(onlineUsers[d.r]) io.to(onlineUsers[d.r]).emit('new_msg', msg);
                }
            });
        });
    });

    socket.on('mark_read', (d) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [d.contact, d.me], function() {
            if(this.changes > 0 && onlineUsers[d.contact]) {
                io.to(onlineUsers[d.contact]).emit('msgs_read_update', { by: d.me });
            }
        });
    });

    socket.on('create_group', d => {
        db.run("INSERT INTO groups (name, avatar, owner) VALUES (?, '', ?)", [d.name, d.owner], function() {
            const gid = this.lastID;
            const members = [...d.members, d.owner];
            members.forEach(m => {
                db.run("INSERT INTO group_members VALUES (?, ?, ?)", [gid, m, m === d.owner ? 1 : 0]);
                if(onlineUsers[m]) io.sockets.sockets.get(onlineUsers[m])?.join(`group_${gid}`);
            });
            io.emit('refresh_chats');
        });
    });

    socket.on('disconnect', () => {
        if(socket.username) {
            const u = socket.username;
            delete onlineUsers[u];
            io.emit('user_status', { username: u, status: 'offline' }); // Alerta geral de Offline
        }
    });
});

// ENDPOINTS COMPLETOS
app.get('/chats/:me', (req, res) => {
    const me = req.params.me;
    const q = `
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
    
    db.all(q, [me, me, me, me, me, me, me], async (err, rows) => {
        if(!rows) return res.json([]);
        const result = await Promise.all(rows.map(async (row) => {
            if(row.is_group) {
                const g = await new Promise(r => db.get("SELECT name, avatar FROM groups WHERE id = ?", [row.chat_id], (e,d)=>r(d)));
                row.display_name = g?.name || "Grupo";
                row.avatar = g?.avatar || "";
            } else {
                const u = await new Promise(r => db.get("SELECT avatar FROM users WHERE username = ?", [row.chat_id], (e,d)=>r(d)));
                row.display_name = row.chat_id;
                row.avatar = u?.avatar || "";
            }
            return row;
        }));
        res.json(result);
    });
});

app.get('/messages/:me/:other', (req, res) => {
    const { me, other } = req.params;
    const isG = /^\d+$/.test(other);
    const q = isG ? "SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE group_id = ?" 
                 : "SELECT *, strftime('%H:%M', time) as f_time FROM messages WHERE (s=? AND r=? AND group_id IS NULL) OR (s=? AND r=? AND group_id IS NULL)";
    db.all(q, isG ? [other] : [me, other, other, me], (e, r) => res.json(r || []));
});

app.get('/get-status', (req, res) => {
    db.all("SELECT s.*, u.avatar FROM stories s JOIN users u ON s.username = u.username WHERE s.time > datetime('now', '-24 hours') ORDER BY s.time DESC", (e, r) => res.json(r || []));
});

app.post('/post-status', (req, res) => {
    db.run("INSERT INTO stories (username, content) VALUES (?, ?)", [req.body.username, req.body.content], () => res.json({ok:true}));
});

app.post('/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, row) => {
        if(row && await bcrypt.compare(req.body.password, row.password)) res.json(row);
        else res.status(401).send();
    });
});

app.post('/register', async (req, res) => {
    const h = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password, avatar, bio) VALUES (?, ?, '', '')", [req.body.username, h], (e) => res.json({ok: !e}));
});

app.get('/users-all', (req,res) => db.all("SELECT username, avatar FROM users", (e,r)=>res.json(r||[])));
app.post('/update-profile', (req,res) => db.run("UPDATE users SET avatar=?, bio=? WHERE username=?", [req.body.avatar, req.body.bio, req.body.username], ()=>res.json({ok:true})));
app.get('/get-feed', (req,res) => db.all("SELECT f.*, u.avatar as user_avatar FROM feed f JOIN users u ON f.username = u.username ORDER BY id DESC", (e,r)=>res.json(r||[])));
app.post('/post-feed', (req,res) => db.run("INSERT INTO feed (username, content, caption, type) VALUES (?,?,?,?)", [req.body.username, req.body.content, req.body.caption, req.body.type], ()=>res.json({ok:true})));

server.listen(3001, () => console.log("RODANDO"));
