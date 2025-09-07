import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// === Middleware ===
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:5500",
  credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());

// === Connexion MySQL robuste ===
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 20000 // 20s
});

// === Création des tables minimales ===
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
}
await ensureTables().catch(err => console.error("Erreur tables:", err.message));

// === Endpoint de test DB ===
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ ok: true, db: rows[0].result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Register ===
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ ok: false, error: "Champs manquants" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, password]
    );
    await pool.execute("INSERT INTO user_settings (user_id) VALUES (?)", [result.insertId]);
    res.json({ ok: true, userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Email déjà utilisé" });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Login ===
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "Champs manquants" });
  }
  try {
    const [rows] = await pool.execute(
      "SELECT id, name, plan FROM users WHERE email = ? AND password = ? LIMIT 1",
      [email, password]
    );
    if (!rows.length) {
      return res.status(401).json({ ok: false, error: "Email ou mot de passe incorrect" });
    }
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Chat avec HuggingFace ===
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ ok: false, error: "Message manquant" });
  }
  try {
    const resp = await axios.post(
      "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
      { inputs: message },
      { headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` }, timeout: 120000 }
    );
    const aiText = resp.data?.generated_text || JSON.stringify(resp.data);
    res.json({ ok: true, response: aiText });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erreur modèle: " + (err?.message || "unknown") });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur en ligne sur http://localhost:${PORT}`);
});
