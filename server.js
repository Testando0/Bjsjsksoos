const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Banco de dados persistente no Render
const db = new sqlite3.Database('./red_v3.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, bio TEXT, avatar TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (s TEXT, r TEXT, c TEXT, type TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// ROTA DE REGISTRO
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Tentativa de registro: ${username}`);
    try {
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password, bio, avatar) VALUES (?, ?, 'Protocolo Ativo', '')", 
        [username, hash], (err) => {
            if (err) {
                console.error("Erro ao inserir:", err.message);
                return res.status(400).json({ error: "Usuário já existe" });
            }
            res.status(200).json({ status: "OK" });
        });
    } catch (e) { res.status(500).json({ error: "Erro interno" }); }
});

// ROTA DE LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err) return res.status(500).json({error: "Erro no banco"});
        if (user && await bcrypt.compare(password, user.password)) {
            res.json(user);
        } else {
            res.status(401).json({ error: "Credenciais inválidas" });
        }
    });
});

// ROTA BUSCAR USUÁRIO
app.get('/user/:u', (req, res) => {
    db.get("SELECT username, bio, avatar FROM users WHERE username = ?", [req.params.u], (err, row) => {
        if (row) res.json(row);
        else res.json({ error: true });
    });
});

// ROTA MENSAGENS ANTIGAS
app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", 
    [req.params.u1, req.params.u2, req.params.u2, req.params.u1], (err, rows) => {
        res.json(rows || []);
    });
});

server.listen(process.env.PORT || 3001, () => console.log("SISTEMA RED ONLINE NA PORTA 3001"));
