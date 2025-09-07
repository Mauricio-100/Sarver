// server.js
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


// --- Connexion à la base de données ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// --- Gestion de la structure de la base de données ---
// Fonction pour créer les tables si elles n'existent pas.
async function ensureTables() {
  const connection = await pool.getConnection();
  try {
    console.log("Vérification et création des tables si nécessaire...");
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
    // ... (les autres créations de table sont identiques, je les omets pour la lisibilité)
    // ... Assurez-vous que vos autres CREATE TABLE sont ici
    console.log("Structure de la base de données prête.");
  } catch (err) {
    console.error("Erreur lors de la création des tables:", err);
    process.exit(1); // Arrête le serveur si la DB n'est pas prête
  } finally {
    connection.release();
  }
}

// NOTE: La fonction suivante est dangereuse et ne doit être utilisée qu'en développement pour réinitialiser la DB.
async function dropAllTables() {
  console.warn("ATTENTION: Suppression de toutes les tables...");
  const tables = ["user_settings","sessions","memories","chat_stats","subscriptions","logs","friends","users"];
  for (const table of tables.reverse()) { // Ordre inversé pour respecter les clés étrangères
    try {
      await pool.execute(`DROP TABLE IF EXISTS ${table}`);
      console.log(`Table ${table} supprimée.`);
    } catch (err) {
      console.error(`Erreur lors de la suppression de la table ${table}:`, err.message);
    }
  }
}


// --- Middleware d'Authentification ---
// Ce middleware protège les routes qui nécessitent d'être connecté.
const authMiddleware = async (req, res, next) => {
  const { session_token } = req.cookies;
  if (!session_token) {
    return res.status(401).json({ ok: false, error: "Non autorisé: token manquant" });
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
      return res.status(401).json({ ok: false, error: "Non autorisé: token invalide ou expiré" });
    }
    req.user = rows[0]; // Ajoute les infos de l'utilisateur à la requête
    next();
  } catch (err) {
    console.error("Erreur dans le middleware d'authentification:", err);
    res.status(500).json({ ok: false, error: "Erreur serveur interne." });
  }
};


// --- Routes API ---

// Endpoint de test de la base de données
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 'Pong!' AS result");
    res.json({ ok: true, db_response: rows[0].result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inscription (Register)
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ ok: false, error: "Tous les champs sont requis." });
  }

  try {
    // Hachage du mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insertion de l'utilisateur
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, hashedPassword]
    );
    const userId = result.insertId;

    // (Optionnel) Insérer des paramètres par défaut pour l'utilisateur
    // await pool.execute("INSERT INTO user_settings (user_id) VALUES (?)", [userId]);

    res.status(201).json({ ok: true, message: "Utilisateur créé avec succès.", userId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Cet email est déjà utilisé." });
    }
    console.error("Erreur d'inscription:", err);
    res.status(500).json({ ok: false, error: "Erreur lors de la création du compte." });
  }
});

// Connexion (Login)
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "Email et mot de passe requis." });
  }

  try {
    const [rows] = await pool.execute("SELECT id, name, email, password, plan FROM users WHERE email = ? LIMIT 1", [email]);
    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Identifiants invalides." });
    }

    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ ok: false, error: "Identifiants invalides." });
    }

    // Création du token de session
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Expiration dans 24h

    await pool.execute(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
      [sessionToken, user.id, expiresAt]
    );

    res.cookie("session_token", sessionToken, {
      httpOnly: true, // Le cookie n'est pas accessible en JS côté client
      secure: process.env.NODE_ENV === "production", // Uniquement en HTTPS en prod
      sameSite: "strict",
      expires: expiresAt,
    });
    
    res.json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan }
    });

  } catch (err) {
    console.error("Erreur de connexion:", err);
    res.status(500).json({ ok: false, error: "Erreur serveur lors de la connexion." });
  }
});

// Déconnexion (Logout)
app.post("/api/logout", authMiddleware, async (req, res) => {
    const { session_token } = req.cookies;
    try {
        await pool.execute("DELETE FROM sessions WHERE token = ?", [session_token]);
        res.clearCookie("session_token");
        res.json({ ok: true, message: "Déconnexion réussie." });
    } catch (err) {
        console.error("Erreur de déconnexion:", err);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});


// Obtenir les informations de l'utilisateur connecté
app.get("/api/me", authMiddleware, (req, res) => {
    // Les informations de l'utilisateur sont déjà dans req.user grâce au middleware
    res.json({ ok: true, user: req.user });
});


// Endpoint de Chat (protégé)
app.post("/api/chat", authMiddleware, async (req, res) => {
  const { message } = req.body;
  const userId = req.user.id; // Obtenu via le middleware d'authentification

  if (!message) {
    return res.status(400).json({ ok: false, error: "Le message ne peut pas être vide." });
  }

  try {
    // Optionnel : Sauvegarder le message de l'utilisateur dans la DB
    // await pool.execute("INSERT INTO memories (user_id, role, content) VALUES (?, 'user', ?)", [userId, message]);

    const response = await axios.post(
      "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
      { inputs: message },
      {
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
        timeout: 120000
      }
    );
    
    // Le format de la réponse de HuggingFace peut varier.
    let aiText = "Désolé, je n'ai pas pu générer de réponse.";
    if (Array.isArray(response.data) && response.data[0] && response.data[0].generated_text) {
        aiText = response.data[0].generated_text;
    }

    // Optionnel : Sauvegarder la réponse de l'IA dans la DB
    // await pool.execute("INSERT INTO memories (user_id, role, content) VALUES (?, 'ai', ?)", [userId, aiText]);

    res.json({ ok: true, response: aiText });
  } catch (err) {
    console.error("Erreur API HuggingFace:", err.response ? err.response.data : err.message);
    res.status(500).json({ ok: false, error: "Le modèle d'IA n'a pas pu répondre. Veuillez réessayer." });
  }
});


// --- Démarrage du serveur ---
const startServer = async () => {
  try {
    // S'assure que la connexion à la DB est OK
    const connection = await pool.getConnection();
    console.log("Connexion à la base de données réussie.");
    connection.release();

    // S'assure que les tables existent
    // await dropAllTables(); // ATTENTION: À n'utiliser qu'en développement !
    await ensureTables();
    
    app.listen(PORT, () => {
      console.log(`🚀 Serveur Mangrat prêt et en ligne sur http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Impossible de démarrer le serveur:", err);
    process.exit(1);
  }
};

startServer();
