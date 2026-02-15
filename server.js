const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// --- CONFIGURAÇÃO DE ARQUIVOS E PASTAS ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

// Garante que as pastas e arquivos existam
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// Cria o users.json se não existir
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- FUNÇÕES AUXILIARES ---

// Ler usuários do JSON com tratamento de erro robusto
const getUsers = () => {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(data || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error("Erro ao ler users.json, resetando para lista vazia:", error.message);
        fs.writeFileSync(USERS_FILE, '[]');
        return [];
    }
};

// Salvar usuários no JSON
const saveUsers = (users) => {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error("Erro ao salvar users.json:", error.message);
    }
};

// Validar formato de imagem Base64
const isValidBase64Image = (str) => {
    if (!str || typeof str !== 'string') return false;
    return /^data:image\/(jpeg|jpg|png|gif|webp);base64,/.test(str);
};

// Salvar imagem Base64 como arquivo
const saveAvatarImage = (username, base64Data) => {
    if (!isValidBase64Image(base64Data)) return '';
    
    try {
        const matches = base64Data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return '';

        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        
        // Limita tamanho da imagem (5MB)
        if (buffer.length > 5 * 1024 * 1024) {
            console.error("Imagem muito grande (>5MB)");
            return '';
        }

        const filename = `${username}_${Date.now()}.${ext}`;
        const filepath = path.join(AVATAR_DIR, filename);

        fs.writeFileSync(filepath, buffer);
        return `/avatars/${filename}`;
    } catch (e) {
        console.error("Erro ao salvar imagem:", e.message);
        return '';
    }
};

// Deletar arquivo antigo de avatar
const deleteOldAvatar = (avatarPath) => {
    if (!avatarPath || avatarPath === '') return;
    try {
        const fullPath = path.join(PUBLIC_DIR, avatarPath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    } catch (e) {
        console.error("Erro ao deletar avatar antigo:", e.message);
    }
};

// Limpar stories antigas (>24h)
const cleanOldStories = () => {
    db.run("DELETE FROM stories WHERE time < datetime('now', '-24 hours')", (err) => {
        if (err) console.error("Erro ao limpar stories antigas:", err.message);
    });
};

// --- CONFIGURAÇÃO DO SERVIDOR ---
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 10e6, // 10MB para uploads
    pingTimeout: 60000,
    pingInterval: 25000
}); 

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

// Mantém SQLite APENAS para mensagens e stories
const db = new sqlite3.Database('./chat_database.db');

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
        time DATETIME DEFAULT (datetime('now'))
    )`);
    
    // Criar índices para performance
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(s, r, time DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_stories_time ON stories(username, time DESC)");
});

const onlineUsers = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKET.IO (MENSAGENS EM TEMPO REAL) ---
io.on('connection', (socket) => {
    console.log('Nova conexão:', socket.id);

    socket.on('join', (username) => {
        if (!username || typeof username !== 'string') return;
        
        socket.username = username; 
        onlineUsers[username] = socket.id;
        
        let users = getUsers();
        let user = users.find(u => u.username === username);
        if (user) {
            user.is_online = true;
            user.last_seen = null;
            saveUsers(users);
        }
        // Emitir para todos que este usuário está online
        io.emit('user_status_change', { username, status: 'online' });
        
        // Enviar lista de usuários online para o usuário que acabou de entrar
        socket.emit('online_list', Object.keys(onlineUsers));
        console.log(`${username} entrou online`);
    });

    socket.on('send_msg', (data) => {
        if (!data || !data.s || !data.r || !data.c) return;
        
        const recipientSocketId = onlineUsers[data.r];
        // Se o destinatário está online, status é 1 (entregue)
        const status = recipientSocketId ? 1 : 0; 
        
        db.run(
            "INSERT INTO messages (s, r, c, type, status, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
            [data.s, data.r, data.c, data.type || 'text', status], 
            function(err) {
                if(err) return console.error("Erro ao salvar mensagem:", err.message);
                
                const msgId = this.lastID;
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
                    if(e || !row) return;
                    
                    // Enviar para o destinatário
                    if(recipientSocketId) {
                        io.to(recipientSocketId).emit('new_msg', row);
                    }
                    // Confirmar para o remetente
                    socket.emit('msg_sent_ok', row);
                    
                    // Notificar mudança nos chats para ambos
                    if(recipientSocketId) io.to(recipientSocketId).emit('update_chat_list');
                    socket.emit('update_chat_list');
                });
            }
        );
    });

    socket.on('mark_read', (data) => {
        if (!data || !data.s || !data.r) return;
        
        db.run(
            "UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", 
            [data.s, data.r], 
            function(err) {
                if(!err && this.changes > 0 && onlineUsers[data.s]) {
                    io.to(onlineUsers[data.s]).emit('msgs_read_update', { reader: data.r });
                }
            }
        );
    });

    socket.on('view_status', (data) => {
        if (!data || !data.viewer || !data.owner || !data.story_id) return;
        if (data.viewer === data.owner) return;
        
        db.get("SELECT viewers FROM stories WHERE id = ?", [data.story_id], (err, row) => {
            if(err || !row) return;
            
            let list = JSON.parse(row.viewers || "[]");
            if(!list.includes(data.viewer)) {
                list.push(data.viewer);
                db.run(
                    "UPDATE stories SET viewers = ? WHERE id = ?", 
                    [JSON.stringify(list), data.story_id], 
                    () => {
                        const ownerSocket = onlineUsers[data.owner];
                        if(ownerSocket) {
                            io.to(ownerSocket).emit('status_viewed', { 
                                story_id: data.story_id, 
                                viewer: data.viewer 
                            });
                        }
                    }
                );
            }
        });
    });
    
    socket.on('disconnect', () => { 
        if(socket.username) {
            console.log(`${socket.username} desconectou`);
            delete onlineUsers[socket.username];
            
            let users = getUsers();
            let user = users.find(u => u.username === socket.username);
            if (user) {
                user.is_online = false;
                user.last_seen = new Date().toISOString();
                saveUsers(users);
            }
            
            io.emit('user_status_change', { 
                username: socket.username, 
                status: 'offline', 
                last_seen: new Date().toISOString() 
            });
        }
    });
});

// --- API DE USUÁRIOS (JSON) ---

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Validações
        if(!username || !password) {
            return res.status(400).json({error: "Usuário e senha são obrigatórios"});
        }
        
        if(username.length < 3 || username.length > 20) {
            return res.status(400).json({error: "Usuário deve ter entre 3 e 20 caracteres"});
        }
        
        if(password.length < 4) {
            return res.status(400).json({error: "Senha deve ter no mínimo 4 caracteres"});
        }
        
        if(!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({error: "Usuário deve conter apenas letras, números e _"});
        }
        
        let users = getUsers();
        if(users.find(u => u.username === username)) {
            return res.status(400).json({error: "Usuário já existe"});
        }

        const hash = await bcrypt.hash(password, 10);
        const newUser = {
            username,
            password: hash,
            bio: 'Olá! Estou usando o Chat.',
            avatar: '',
            is_verified: false,
            is_online: false,
            last_seen: null
        };

        users.push(newUser);
        saveUsers(users);
        res.json({ok: true, message: "Usuário criado com sucesso"});
    } catch(e) { 
        console.error("Erro no registro:", e.message);
        res.status(500).json({error: "Erro interno do servidor"}); 
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if(!username || !password) {
            return res.status(400).json({error: "Usuário e senha são obrigatórios"});
        }
        
        let users = getUsers();
        const user = users.find(u => u.username === username);

        if(user && await bcrypt.compare(password, user.password)) { 
            const { password, ...userSafe } = user;
            res.json(userSafe); 
        } else {
            res.status(401).json({error: "Credenciais inválidas"});
        }
    } catch (e) { 
        console.error("Erro no login:", e.message);
        res.status(500).json({error: "Erro interno do servidor"}); 
    }
});

app.get('/user/:u', (req, res) => {
    try {
        const username = req.params.u;
        if (!username) return res.status(400).json({error: "Usuário inválido"});
        
        const users = getUsers();
        const user = users.find(u => u.username === username);
        
        if(user) {
            const { password, ...userSafe } = user;
            res.json(userSafe);
        } else {
            // Retorna dados básicos se não encontrar
            res.json({ 
                username: username, 
                avatar: '', 
                is_verified: false,
                is_online: false,
                bio: ''
            });
        }
    } catch(e) {
        console.error("Erro ao buscar usuário:", e.message);
        res.status(500).json({error: "Erro interno"});
    }
});

// Atualizar Perfil e Salvar Imagem
app.post('/update-profile', (req, res) => {
    try {
        const { username, bio, avatar } = req.body;
        
        if (!username) {
            return res.status(400).json({error: "Usuário não fornecido"});
        }
        
        let users = getUsers();
        let userIndex = users.findIndex(u => u.username === username);

        if(userIndex === -1) {
            return res.status(404).json({error: "Usuário não encontrado"});
        }
        
        // Atualiza bio
        if (bio !== undefined) {
            users[userIndex].bio = bio.substring(0, 200); // Limita a 200 chars
        }
        
        // Atualiza avatar
        if(avatar && avatar.startsWith('data:image')) {
            const oldAvatar = users[userIndex].avatar;
            const savedPath = saveAvatarImage(username, avatar);
            
            if(savedPath) {
                // Remove avatar antigo
                if(oldAvatar) deleteOldAvatar(oldAvatar);
                users[userIndex].avatar = savedPath;
            } else {
                return res.status(400).json({error: "Erro ao processar imagem"});
            }
        } 
        else if (avatar === "") {
            const oldAvatar = users[userIndex].avatar;
            if(oldAvatar) deleteOldAvatar(oldAvatar);
            users[userIndex].avatar = "";
        }
        
        saveUsers(users);
        res.json({ok: true, avatar: users[userIndex].avatar});
    } catch(e) {
        console.error("Erro ao atualizar perfil:", e.message);
        res.status(500).json({error: "Erro interno do servidor"});
    }
});

// --- API CHATS ---

app.get('/chats/:me', (req, res) => {
    try {
        const me = req.params.me;
        if (!me) return res.status(400).json([]);
        
        const q = `
            SELECT m.id, m.s, m.r, m.c, m.type, m.status, m.time 
            FROM messages m 
            WHERE (m.s = ? OR m.r = ?)
            ORDER BY m.id DESC`;

        db.all(q, [me, me], (e, rows) => {
            if(e) {
                console.error("Erro ao buscar chats:", e.message);
                return res.json([]);
            }
            
            const chatsMap = {};
            rows.forEach(row => {
                const contact = row.s === me ? row.r : row.s;
                if(!chatsMap[contact]) {
                    chatsMap[contact] = {
                        contact: contact,
                        last_msg: row.c,
                        last_type: row.type,
                        last_status: row.status,
                        last_sender: row.s,
                        last_time: row.time,
                        unread: 0
                    };
                }
                if(row.r === me && row.s === contact && row.status < 2) {
                    chatsMap[contact].unread++;
                }
            });

            const users = getUsers();
            const result = Object.values(chatsMap).map(chat => {
                const uData = users.find(u => u.username === chat.contact);
                return {
                    ...chat,
                    avatar: uData ? uData.avatar : '',
                    is_online: uData ? uData.is_online : false,
                    is_verified: uData ? uData.is_verified : false
                };
            });

            res.json(result);
        });
    } catch(e) {
        console.error("Erro em /chats:", e.message);
        res.json([]);
    }
});

app.get('/messages/:u1/:u2', (req, res) => {
    try {
        const { u1, u2 } = req.params;
        if (!u1 || !u2) return res.json([]);
        
        db.all(
            "SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY id ASC", 
            [u1, u2, u2, u1], 
            (e, r) => {
                if(e) {
                    console.error("Erro ao buscar mensagens:", e.message);
                    return res.json([]);
                }
                res.json(r || []);
            }
        );
    } catch(e) {
        console.error("Erro em /messages:", e.message);
        res.json([]);
    }
});

// --- API STATUS / STORIES ---

app.post('/post-status', (req, res) => {
    try {
        const { username, content, type, caption, bg_color } = req.body;
        
        if (!username || !content) {
            return res.status(400).json({error: "Dados incompletos"});
        }
        
        // Limita tamanho do conteúdo
        if (content.length > 10 * 1024 * 1024) {
            return res.status(400).json({error: "Conteúdo muito grande"});
        }
        
        db.run(
            "INSERT INTO stories (username, content, type, caption, bg_color, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
            [username, content, type || 'image', caption || '', bg_color || ''], 
            function(err) {
                if(err) {
                    console.error("Erro ao postar status:", err.message);
                    return res.status(500).json({error: "Erro ao salvar status"});
                }
                res.json({ok: true, id: this.lastID});
            }
        );
    } catch(e) {
        console.error("Erro em /post-status:", e.message);
        res.status(500).json({error: "Erro interno"});
    }
});

app.get('/get-status', (req, res) => {
    try {
        db.all(
            "SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time DESC", 
            (e, rows) => {
                if(e) {
                    console.error("Erro ao buscar status:", e.message);
                    return res.json([]);
                }
                
                const users = getUsers();
                const result = rows.map(r => {
                    const u = users.find(user => user.username === r.username);
                    return {
                        ...r,
                        viewers: JSON.parse(r.viewers || "[]"),
                        avatar: u ? u.avatar : '',
                        is_verified: u ? u.is_verified : false
                    };
                });
                res.json(result);
            }
        );
    } catch(e) {
        console.error("Erro em /get-status:", e.message);
        res.json([]);
    }
});

app.get('/story-viewers/:id', (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.json([]);
        
        db.get("SELECT viewers FROM stories WHERE id = ?", [id], (err, row) => {
            if(err) {
                console.error("Erro ao buscar viewers:", err.message);
                return res.json([]);
            }
            if(row) {
                res.json(JSON.parse(row.viewers || "[]"));
            } else {
                res.json([]);
            }
        });
    } catch(e) {
        console.error("Erro em /story-viewers:", e.message);
        res.json([]);
    }
});

// Limpar stories antigas a cada hora
setInterval(cleanOldStories, 60 * 60 * 1000);

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
    console.error('Erro não capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejeitada não tratada:', reason);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`✅ Socket.IO ativo e aguardando conexões`);
});
