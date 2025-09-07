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

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:5500",
  credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());

// Connexion MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  connectionLimit: 10
});

// Supprime toutes les anciennes tables (sécurisé avec FK)
async function dropOldTables() {
  const tables = ["user_settings","sessions","memories","chat_stats","subscriptions","logs","friends","users"];
  for (const table of tables) {
    try {
      await pool.execute(`DROP TABLE IF EXISTS ${table}`);
      console.log(`Table ${table} supprimée`);
    } catch (err) {
      console.error(`Erreur suppression table ${table}:`, err.message);
    }
  }
}

// Crée toutes les tables
async function ensureTables() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200),
      email VARCHAR(200) UNIQUE,
      password VARCHAR(200),
      plan ENUM('basic','premium') DEFAULT 'basic',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id BIGINT UNSIGNED PRIMARY KEY,
      theme ENUM('light','dark') DEFAULT 'dark',
      notifications BOOLEAN DEFAULT TRUE,
      language VARCHAR(10) DEFAULT 'fr',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY,
      user_id BIGINT UNSIGNED,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS memories (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED,
      role ENUM('user','ai'),
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS chat_stats (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED,
      tokens_used INT DEFAULT 0,
      messages_sent INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED,
      plan ENUM('basic','premium') DEFAULT 'basic',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED,
      action VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS friends (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED,
      friend_id BIGINT UNSIGNED,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

// Initialisation
await dropOldTables().catch(console.error);
await ensureTables().catch(console.error);

// Test DB
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1+1 AS result");
    res.json({ ok: true, db: rows[0].result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Register
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });
  try {
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, password]
    );
    await pool.execute("INSERT INTO user_settings (user_id) VALUES (?)", [result.insertId]);
    res.json({ ok: true, userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ ok: false, error: "Email déjà utilisé" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: "Champs manquants" });
  try {
    const [rows] = await pool.execute(
      "SELECT id, name, plan FROM users WHERE email = ? AND password = ? LIMIT 1", [email, password]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: "Email ou mot de passe incorrect" });
    const user = rows[0];
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Chat avec Mistral Mixtral
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: "Message manquant" });

  try {
    const resp = await axios.post(
      "https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-Instruct-v0.1",
      { inputs: message },
      {
        headers: {
          "Authorization": `Bearer ${process.env.HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 120000
      }
    );

    const aiText = resp.data?.[0]?.generated_text || JSON.stringify(resp.data);
    res.json({ ok: true, response: aiText });

    // Optionnel: sauvegarder mémoire
    // await pool.execute("INSERT INTO memories (user_id, role, content) VALUES (?, 'ai', ?)", [userId, aiText]);

  } catch (err) {
    res.status(500).json({ ok: false, error: "Erreur modèle: " + (err.message || "unknown") });
  }
});

// GET memories
app.get("/api/memories", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM memories ORDER BY created_at DESC LIMIT 100");
    res.json({ ok: true, memories: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET chat_stats
app.get("/api/chat_stats", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM chat_stats ORDER BY created_at DESC LIMIT 100");
    res.json({ ok: true, chat_stats: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Mangrat backend prêt et en ligne sur le port ${PORT}`);
});
