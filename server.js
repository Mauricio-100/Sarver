/**
 * server.js
 * Backend minimal pour Mangrat v4omini
 *
 * Prérequis :
 * - Node.js 18+ installé
 * - MySQL accessible (utilise la config Aiven fournie)
 * - Un serveur d'inférence local pour Mixtral (ex: text-generation-inference, or custom) accessible en HTTP
 *
 * Usage :
 *  - copier .env.example -> .env et adapter
 *  - npm install
 *  - npm start
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

// CORS - autoriser ton frontend (si tu testes en local)
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:5500",
  credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());

// Connexion MySQL (pool)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  connectionLimit: 10
});

// Endpoint de test DB
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ ok: true, db: rows[0].result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Helper : create tables if not exists
 */
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

// Auth simple : register
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });

  try {
    const [result] = await pool.execute("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, password]);
    res.json({ ok: true, userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ ok: false, error: "Email déjà utilisé" });
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Login -> crée une session (token dans cookie)
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });

  try {
    const [rows] = await pool.execute("SELECT id, name, plan FROM users WHERE email = ? AND password = ? LIMIT 1", [email, password]);
    if (!rows.length) return res.status(401).json({ ok: false, error: "Email ou mot de passe incorrect" });

    const user = rows[0];
    // créer session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 jours
    await pool.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, user.id, expiresAt]);

    // cookie httpOnly
    res.cookie("mangrat_token", token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 });
    res.json({ ok: true, user: { id: user.id, name: user.name, plan: user.plan } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Middleware pour récupérer l'utilisateur via cookie
async function authMiddleware(req, res, next) {
  const token = req.cookies?.mangrat_token || req.headers["x-session-token"];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const [rows] = await pool.execute("SELECT s.token, s.user_id, u.name, u.email, u.plan FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > NOW()) LIMIT 1", [token]);
    if (!rows.length) {
      req.user = null;
      return next();
    }
    req.user = { id: rows[0].user_id, name: rows[0].name, email: rows[0].email, plan: rows[0].plan, token: token };
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

// Endpoint: upgrade vers premium (simple toggle)
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

// Endpoint: clear memory (supprime les mémoires de l'utilisateur)
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

// Helper: push memory
async function pushMemory(userId, role, content) {
  await pool.execute("INSERT INTO memories (user_id, role, content) VALUES (?, ?, ?)", [userId, role, content]);
}

// Get last N messages from memory
async function getMemory(userId, limit = 20) {
  const [rows] = await pool.execute("SELECT role, content, created_at FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
  return rows.reverse(); // plus ancien -> plus récent
}

/**
 * Chat endpoint : envoie la requête au modèle local d'inférence (configurable)
 * Pour simplifier nous appelons un serveur d'inférence local via HTTP (ex: text-generation-inference)
 *
 * Exemplaires d'options :
 * - TEXT_GEN_URL=http://localhost:8080/generate
 * ou
 * - TEXT_GEN_URL=http://localhost:7860/api/predict (selon ton serveur)
 *
 * Le corps envoyé dépend du serveur d'inférence. Ici on suppose une API simple qui accepte:
 * { "prompt": "...", "max_tokens": 512, "temperature": 0.2 }
 */
app.post("/api/chat", authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: "Message manquant" });

  // si non authentifié, on autorise quand même mais memory null
  const userId = req.user ? req.user.id : null;
  const isPremium = req.user ? req.user.plan === "premium" : false;

  try {
    // Récupérer mémoire récente si utilisateur connecté
    let memoryText = "";
    if (userId) {
      const mem = await getMemory(userId, 10);
      memoryText = mem.map(m => `${m.role}: ${m.content}`).join("\n");
    }

    // Construire prompt : système + mémoire + user
    const systemPrefix = `Tu es Mangrat v4omini, assistant utile. Réponds en français. Si l'utilisateur est premium, fournis des réponses plus détaillées.`;
    const prompt = `${systemPrefix}\n\nMémoire:\n${memoryText}\n\nUtilisateur: ${message}\n\nRéponse:`;


    // Paramètres pour l'inférence - ajuste selon ton serveur
    const genRequest = {
      prompt,
      max_tokens: isPremium ? 512 : 200,
      temperature: isPremium ? 0.2 : 0.1,
      top_p: 0.95
    };

    // Appel au serveur d'inférence local (URL configurable)
    const TEXT_GEN_URL = process.env.TEXT_GEN_URL || "http://localhost:8080/generate";

    // Exemple pour un serveur qui retourne { generated_text: "..." }
    const resp = await axios.post(TEXT_GEN_URL, genRequest, { timeout: 120000 });
    // adapter selon le format de réponse de ton serveur d'inférence
    const aiText = resp.data.generated_text || resp.data.text || resp.data.output || (resp.data[0] && resp.data[0].text) || JSON.stringify(resp.data);

    // Sauvegarder dans la mémoire si user connecté
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
