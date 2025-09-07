/**
 * server.js - Backend Mangrat v4omini amélioré
 * Utilise GPT2 large public Hugging Face
 */

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { v4 as uuidv4 } from "uuid";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:5500",
  credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());

// MySQL pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  connectionLimit: 10
});

// Ping DB
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1+1 AS result");
    res.json({ ok: true, db: rows[0].result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Créer toutes les tables nécessaires
async function ensureTables() {
  // Users
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(200),
      email VARCHAR(200) UNIQUE,
      password VARCHAR(200),
      plan ENUM('basic','premium') DEFAULT 'basic',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Sessions
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY,
      user_id BIGINT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Memories
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT,
      role ENUM('user','ai'),
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // User settings
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id BIGINT PRIMARY KEY,
      theme ENUM('light','dark') DEFAULT 'dark',
      notifications BOOLEAN DEFAULT TRUE,
      language VARCHAR(10) DEFAULT 'fr',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Chat statistics
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS chat_stats (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT,
      messages_sent INT DEFAULT 0,
      messages_received INT DEFAULT 0,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Subscriptions / payments (facultatif pour futur paywall)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT,
      type ENUM('monthly','yearly') DEFAULT 'monthly',
      status ENUM('active','inactive') DEFAULT 'inactive',
      started_at DATETIME,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Logs pour audit et erreurs
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS logs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      type ENUM('error','info','warn') DEFAULT 'info',
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Toutes les tables sont vérifiées/créées ✅");
}

ensureTables().catch(console.error);

// --- AUTH REGISTER ---
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });

  try {
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, password]
    );
    // créer settings par défaut
    await pool.execute("INSERT INTO user_settings (user_id) VALUES (?)", [result.insertId]);
    res.json({ ok: true, userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ ok: false, error: "Email déjà utilisé" });
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- AUTH LOGIN ---
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });

  try {
    const [rows] = await pool.execute(
      "SELECT id, name, plan FROM users WHERE email = ? AND password = ? LIMIT 1",
      [email, password]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: "Email ou mot de passe incorrect" });

    const user = rows[0];
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    await pool.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, user.id, expiresAt]);

    res.cookie("mangrat_token", token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 });
    res.json({ ok: true, user: { id: user.id, name: user.name, plan: user.plan }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- AUTH MIDDLEWARE ---
async function authMiddleware(req, res, next) {
  const token = req.cookies?.mangrat_token || req.headers["x-session-token"];
  if (!token) { req.user = null; return next(); }

  try {
    const [rows] = await pool.execute(
      `SELECT s.token, s.user_id, u.name, u.email, u.plan
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > NOW())
       LIMIT 1`,
      [token]
    );
    if (!rows.length) { req.user = null; return next(); }

    req.user = { id: rows[0].user_id, name: rows[0].name, email: rows[0].email, plan: rows[0].plan, token };
    next();
  } catch (err) {
    console.error(err);
    req.user = null;
    next();
  }
}

// --- LOGOUT ---
app.post("/api/logout", authMiddleware, async (req, res) => {
  try {
    const token = req.cookies?.mangrat_token || req.headers["x-session-token"];
    if (token) {
      await pool.execute("DELETE FROM sessions WHERE token = ?", [token]);
      res.clearCookie("mangrat_token");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- UPGRADE ---
app.post("/api/upgrade", authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: "Non authentifié" });
  try {
    await pool.execute("UPDATE users SET plan = 'premium' WHERE id = ?", [req.user.id]);
    res.json({ ok: true, plan: "premium" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- MEMORY ---
async function pushMemory(userId, role, content) {
  await pool.execute("INSERT INTO memories (user_id, role, content) VALUES (?, ?, ?)", [userId, role, content]);
}

async function getMemory(userId, limit = 20) {
  const [rows] = await pool.execute("SELECT role, content, created_at FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
  return rows.reverse();
}

app.post("/api/clear-memory", authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: "Non authentifié" });
  try {
    await pool.execute("DELETE FROM memories WHERE user_id = ?", [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- CHAT GPT2 PUBLIC ---
app.post("/api/chat", authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: "Message manquant" });

  const userId = req.user ? req.user.id : null;
  const isPremium = req.user ? req.user.plan === "premium" : false;

  try {
    let memoryText = "";
    if (userId) {
      const mem = await getMemory(userId, 10);
      memoryText = mem.map(m => `${m.role}: ${m.content}`).join("\n");
    }

    const systemPrefix = `Tu es Mangrat v4omini, assistant utile. Réponds en français.`;
    const prompt = `${systemPrefix}\n\nMémoire:\n${memoryText}\n\nUtilisateur: ${message}\n\nRéponse:`;

    const HF_PUBLIC_URL = "https://transformer.huggingface.co/doc/gpt2-large";
    const resp = await axios.post(HF_PUBLIC_URL, { inputs: prompt });
    const aiText = resp.data?.generated_text || "Erreur génération";

    if (userId) {
      await pushMemory(userId, "user", message);
      await pushMemory(userId, "ai", aiText);
      // Mettre à jour stats chat
      await pool.execute(`
        INSERT INTO chat_stats (user_id, messages_sent, messages_received)
        VALUES (?, 1, 1)
        ON DUPLICATE KEY UPDATE
        messages_sent = messages_sent + 1,
        messages_received = messages_received + 1,
        last_active = NOW()
      `, [userId]);
    }

    res.json({ ok: true, response: aiText });
  } catch (err) {
    console.error("Erreur inference", err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: "Erreur modèle: " + (err?.message || "unknown") });
  }
});

app.listen(PORT, () => {
  console.log(`Mangrat backend amélioré en ligne sur port ${PORT}`);
});
