require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const port = 3000; // Le port de notre serveur interne

// Middlewares
app.use(cors()); // Autorise les requêtes depuis notre page web
app.use(express.json()); // Permet de lire le JSON envoyé par le client
app.use(express.static('public')); // Sert les fichiers du dossier 'public' (notre index.html)

// L'URL du modèle de langage sur Hugging Face
const API_URL = "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2";
const HUGGING_FACE_TOKEN = process.env.HUGGING_FACE_TOKEN;

// La route que le front-end va appeler
app.post('/api/ask', async (req, res) => {
    const { question, context } = req.body;

    if (!question) {
        return res.status(400).json({ error: "La question est manquante." });
    }

    log(`Reçu une question : "${question}"`);
    log(`Contexte local fourni : ${context.length} caractères`);

    // On combine la question avec le contexte trouvé dans IndexedDB pour une meilleure réponse
    const prompt = `Contexte: ${context}\n\nEn te basant sur le contexte ci-dessus et tes connaissances générales, réponds à la question suivante de manière claire et concise.\n\nQuestion: ${question}\n\nRéponse:`;

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HUGGING_FACE_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: prompt,
                parameters: {
                    max_new_tokens: 250, // Limite la longueur de la réponse
                    return_full_text: false // Ne renvoie que la réponse générée
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Erreur Hugging Face: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        const answer = result[0]?.generated_text || "Je n'ai pas pu générer de réponse.";
        log(`Réponse de l'IA : "${answer.substring(0, 50)}..."`);
        res.json({ answer });

    } catch (error) {
        log(`Erreur: ${error.message}`);
        res.status(500).json({ error: "Une erreur est survenue lors de la communication avec l'IA." });
    }
});

app.listen(port, () => {
    console.log(`🚀 Serveur Mangrat IA démarré sur http://localhost:${port}`);
});

function log(msg) {
    const t = new Date().toLocaleTimeString();
    console.log(`[Serveur ${t}] ${msg}`);
}
