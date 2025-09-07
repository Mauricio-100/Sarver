import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import axios from "axios";
import bcrypt from "bcrypt";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5500",
  credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());

// --- Connexion MySQL ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "3306", 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  acquireTimeout: 10000,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined
});

// --- Création des tables si elles n'existent pas ---
async function ensureTables() {
  const connection = await pool.getConnection();
  try {
    console.log("Vérification des tables...");
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL UNIQUE,
        password VARCHAR(200) NOT NULL,
        plan ENUM('basic','premium') DEFAULT 'basic',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        token VARCHAR(255) NOT NULL UNIQUE,
        user_id BIGINT UNSIGNED NOT NULL,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    console.log("Tables OK.");
  } catch (err) {
    console.error("Erreur lors de la création des tables:", err);
    process.exit(1);
  } finally {
    connection.release();
  }
}

// --- Auth middleware ---
const authMiddleware = async (req, res, next) => {
  const { session_token } = req.cookies;
  if (!session_token) {
    return res.status(401).json({ ok: false, error: "Non autorisé : token manquant" });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.plan
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > NOW()`,
      [session_token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Non autorisé : token invalide ou expiré" });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    console.error("Erreur middleware auth:", err);
    res.status(500).json({ ok: false, error: "Erreur serveur interne." });
  }
};

// --- API Routes ---

// Ping DB
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 'Pong!' AS result");
    res.json({ ok: true, db_response: rows[0].result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Register
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ ok: false, error: "Tous les champs sont requis." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, hashedPassword]
    );

    res.status(201).json({ ok: true, message: "Utilisateur créé.", userId: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Cet email est déjà utilisé." });
    }
    console.error("Erreur register:", err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "Email et mot de passe requis." });
  }

  try {
    const [rows] = await pool.execute(
      "SELECT id, name, email, password, plan FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Identifiants invalides." });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ ok: false, error: "Identifiants invalides." });
    }

    const sessionToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.execute(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
      [sessionToken, user.id, expiresAt]
    );

    res.cookie("session_token", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      expires: expiresAt
    });

    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error("Erreur login:", err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

// Logout
app.post("/api/logout", authMiddleware, async (req, res) => {
  const { session_token } = req.cookies;
  try {
    await pool.execute("DELETE FROM sessions WHERE token = ?", [session_token]);
    res.clearCookie("session_token");
    res.json({ ok: true, message: "Déconnexion réussie." });
  } catch (err) {
    console.error("Erreur logout:", err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

// Get current user
app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Chat (via Hugging Face)
app.post("/api/chat", authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ ok: false, error: "Message vide." });
  }

  try {
    const response = await axios.post(
      "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
      { inputs: message },
      { headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` }, timeout: 120000 }
    );

    let aiText = "Désolé, pas de réponse.";
    if (Array.isArray(response.data) && response.data[0]?.generated_text) {
      aiText = response.data[0].generated_text;
    }

    res.json({ ok: true, response: aiText });
  } catch (err) {
    console.error("Erreur HuggingFace:", err.response ? err.response.data : err.message);
    res.status(500).json({ ok: false, error: "Le modèle n'a pas répondu." });
  }
});

// --- Lancement serveur ---
const startServer = async () => {
  try {
    const connection = await pool.getConnection();
    console.log("Connexion DB réussie.");
    connection.release();

    await ensureTables();

    app.listen(PORT, () => {
      console.log(`🚀 Serveur en ligne sur http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Impossible de démarrer:", err);
    process.exit(1);
  }
};

startServer();
