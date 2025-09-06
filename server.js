import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import mysql from "mysql2/promise";

const app = express();
app.use(express.json());

// ⚠️ CORS pour front-end
app.use(cors({ origin: "*" }));

const HF_TOKEN = process.env.HF_TOKEN || "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";
const MYSQL_DSN = process.env.MYSQL_DSN || "mysql://avnadmin:AVNS_BvVULOCxM7CcMQd0Aqw@mysql-1a36101-botwii.c.aivencloud.com:14721/defaultdb?ssl-mode=REQUIRED";

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

app.post("/api/ask", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "Missing question" });

  try {
    // 1️⃣ MySQL
    let conn = null;
    try {
      conn = await mysql.createConnection(parseDSN(MYSQL_DSN));
      const [rows] = await conn.query(
        "SELECT answer FROM faq WHERE ? REGEXP question_pattern LIMIT 1",
        [question]
      );
      if (rows.length > 0) return res.json({ answer: rows[0].answer });
    } catch (err) {
      console.error("MySQL non disponible:", err.message);
    } finally {
      if (conn) await conn.end();
    }

    // 2️⃣ Hugging Face
    const hfResp = await fetch(
      "https://api-inference.huggingface.co/models/mistralai/Mixtral-8x7B-v0.1",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: `Réponds en français, concis et utile.\nQuestion: "${question}"`,
          parameters: { max_new_tokens: 200, temperature: 0.7 },
        }),
      }
    );

    if (!hfResp.ok) {
      const msg = await hfResp.text();
      throw new Error("HF error: " + msg);
    }

    const data = await hfResp.json();
    const answer = Array.isArray(data) ? data[0]?.generated_text : data.generated_text;
    res.json({ answer: answer?.trim() || "(pas de réponse)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur en ligne : http://localhost:${PORT}`));
