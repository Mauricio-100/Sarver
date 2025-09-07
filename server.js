/**
 * server.js
 * Backend minimal pour Mangrat v4omini avec Hugging Face
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

// Test DB
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ ok: true, db: rows[0].result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Créer les tables si elles n'existent pas
async function ensureTables() {
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

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY,
      user_id BIGINT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT,
      role ENUM('user','ai'),
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
ensureTables().catch(console.error);

// Auth - register
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });

  try {
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, password]
    );
    res.json({ ok: true, userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ ok: false, error: "Email déjà utilisé" });
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Login
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
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 jours
    await pool.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, user.id, expiresAt]);

    res.cookie("mangrat_token", token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 });
    res.json({ ok: true, user: { id: user.id, name: user.name, plan: user.plan } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Middleware auth
async function authMiddleware(req, res, next) {
  const token = req.cookies?.mangrat_token || req.headers["x-session-token"];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const [rows] = await pool.execute(
      "SELECT s.token, s.user_id, u.name, u.email, u.plan FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > NOW()) LIMIT 1",
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

// Logout
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

// Upgrade
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

// Clear memory
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

// Push memory
async function pushMemory(userId, role, content) {
  await pool.execute("INSERT INTO memories (user_id, role, content) VALUES (?, ?, ?)", [userId, role, content]);
}

// Get memory
async function getMemory(userId, limit = 20) {
  const [rows] = await pool.execute("SELECT role, content, created_at FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
  return rows.reverse();
}

// Chat avec Hugging Face Inference
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

    // Hugging Face
    const HF_API_URL = "https://api-inference.huggingface.co/models/gpt2"; // exemple open source
    const resp = await axios.post(HF_API_URL,
      { inputs: prompt, parameters: { max_new_tokens: isPremium ? 512 : 200 } },
      { headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` } }
    );

    const aiText = resp.data?.[0]?.generated_text || resp.data?.generated_text || "Erreur génération";

    if (userId) {
      await pushMemory(userId, "user", message);
      await pushMemory(userId, "ai", aiText);
    }

    res.json({ ok: true, response: aiText });
  } catch (err) {
    console.error("Erreur inference", err?.response?.data || err.message);
    res.status(500).json({ ok: false, error: "Erreur modèle: " + (err?.message || "unknown") });
  }
});

app.listen(PORT, () => {
  console.log(`Mangrat backend running on port ${PORT}`);
});
