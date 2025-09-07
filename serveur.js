// serveur.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import MySQL from "mysql2/promise";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import crypto from "crypto";
import axios from "axios";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === CORS ===
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5500",
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// === MySQL pool ===
const pool = MySQL.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// === Création des tables si elles n'existent pas ===
async function ensureTables() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL UNIQUE,
        password VARCHAR(200) NOT NULL,
        plan ENUM('basic','premium') DEFAULT 'basic',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log("Tables OK");
  } catch (err) {
    console.error("Erreur création tables:", err);
    process.exit(1);
  } finally {
    conn.release();
  }
}

// === Middleware auth ===
const authMiddleware = async (req, res, next) => {
  const token = req.cookies.session_token;
  if (!token) return res.status(401).json({ ok: false, error: "Non autorisé" });

  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.plan
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > NOW()`,
      [token]
    );

    if (!rows.length) return res.status(401).json({ ok: false, error: "Token invalide ou expiré" });

    req.user = rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
};

// === Routes ===
app.get("/api/ping", async (req, res) => res.json({ ok: true, message: "pong" }));

// Register
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "Tous les champs sont requis" });

  try {
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.execute("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hashed]);
    res.status(201).json({ ok: true, message: "Utilisateur créé", userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ ok: false, error: "Email déjà utilisé" });
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Email et mot de passe requis" });

  try {
    const [rows] = await pool.execute("SELECT * FROM users WHERE email=? LIMIT 1", [email]);
    if (!rows.length) return res.status(401).json({ ok: false, error: "Identifiants invalides" });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: "Identifiants invalides" });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24*60*60*1000);
    await pool.execute("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)", [user.id, token, expiresAt]);

    res.cookie("session_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      expires: expiresAt
    });

    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// Logout
app.post("/api/logout", authMiddleware, async (req, res) => {
  try {
    await pool.execute("DELETE FROM sessions WHERE token=?", [req.cookies.session_token]);
    res.clearCookie("session_token");
    res.json({ ok: true, message: "Déconnecté" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur" });
  }
});

// Get current user
app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Chat endpoint
app.post("/api/chat", authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: "Message vide" });

  try {
    const response = await axios.post(
      "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
      { inputs: message },
      { headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` }, timeout: 120000 }
    );

    let aiText = "Désolé, pas de réponse.";
    if (Array.isArray(response.data) && response.data[0]?.generated_text) aiText = response.data[0].generated_text;

    res.json({ ok: true, response: aiText });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: "Erreur API IA" });
  }
});

// === Start server ===
const startServer = async () => {
  try {
    const conn = await pool.getConnection();
    conn.release();
    await ensureTables();
    app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur http://localhost:${PORT}`));
  } catch (err) {
    console.error("Impossible de démarrer:", err);
    process.exit(1);
  }
};

startServer();
