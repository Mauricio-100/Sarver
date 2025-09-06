// server.js
import express from "express";
import fetch from "node-fetch";
import mysql from "mysql2/promise";

const app = express();
app.use(express.json());

// ⚠️ Variables d'environnement à configurer dans Render
const HF_TOKEN = process.env.HF_TOKEN; // ton token Hugging Face
const MYSQL_DSN = process.env.MYSQL_DSN; // ton DSN MySQL

if (!HF_TOKEN) console.warn("⚠️ HF_TOKEN non défini !");
if (!MYSQL_DSN) console.warn("⚠️ MYSQL_DSN non défini !");

// Fonction helper pour parser DSN MySQL
function parseDSN(dsn) {
  const url = new URL(dsn);
  return {
    host: url.hostname,
    port: url.port,
    user: url.username,
    password: url.password,
    database: url.pathname.replace("/", ""),
    ssl: { rejectUnauthorized: false }
  };
}

// Fonction pour interroger la base MySQL
async function queryMySQL(question) {
  if (!MYSQL_DSN) return null;
  let conn;
  try {
    conn = await mysql.createConnection(parseDSN(MYSQL_DSN));
    const [rows] = await conn.query(
      "SELECT answer FROM faq WHERE question_pattern REGEXP ? LIMIT 1",
      [question]
    );
    if (rows.length > 0) return rows[0].answer;
  } catch (err) {
    console.error("[MySQL] Erreur:", err.message);
  } finally {
    if (conn) await conn.end();
  }
  return null;
}

// Fonction pour appeler Hugging Face
async function callHF(question) {
  if (!HF_TOKEN) throw new Error("HF_TOKEN non défini !");
  const url = "https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-v0.1";

  const body = {
    inputs: `Réponds en français, concis et utile.\nQuestion: "${question}"`,
    parameters: { max_new_tokens: 200, temperature: 0.7 },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("HF error: " + text);
  }

  const data = await resp.json();
  return Array.isArray(data) ? data[0]?.generated_text : data.generated_text;
}

// Endpoint /api/ask
app.post("/api/ask", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Missing question" });

  console.log("Question reçue:", question);

  try {
    // 1️⃣ Cherche dans MySQL
    let answer = await queryMySQL(question);

    // 2️⃣ Sinon appel Hugging Face
    if (!answer) answer = await callHF(question);

    res.json({ answer: answer?.trim() || "(pas de réponse)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Port dynamique pour Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Serveur en ligne : http://localhost:${PORT}`));
