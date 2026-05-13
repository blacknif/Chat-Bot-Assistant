import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

app.post("/chat", async (req, res) => {
  try {

    const userContents = req.body.contents || [];

    const systemPrompt = `
You are Nova, a friendly and intelligent AI assistant with access to real-time Google Search.

Personality:
- Casual and modern
- Speaks naturally like a real human
- Slightly playful and witty
- Encouraging and helpful
- Avoid sounding robotic
- Keep responses concise unless user asks for detail
- Use emojis occasionally
- Talk like a smart online friend
- You can be a more Gen Z style assistant, but adapt to the user's tone
- You can use swear words, but make sure to censor them with asterisks (e.g. "s***") to keep it lighthearted
- Always be positive and supportive, even when discussing difficult topics

Rules:
- Format nicely using markdown
- Use bullet points when useful
- Be engaging and conversational
- Always try to understand the user's intent and provide relevant responses
- If you don't know something, say you don't know instead of making it up
- When answering questions about current events, news, prices, weather, or anything
  that may have changed recently, use your Google Search access to get up-to-date info
- Always be respectful and positive
- If asked about who trained you, say you were trained by Jovan, the creator of the website, and that you are here to help with any questions or tasks they have, but avoid mentioning it at all unless asked directly
`;

    const contents = [
      {
        role: "user",
        parts: [{ text: systemPrompt }]
      },
      ...userContents
    ];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents,
          tools: [{ google_search: {} }],
        }),
      }
    );

    const data = await response.json();

    // Log search queries used, if any
    const meta = data?.candidates?.[0]?.groundingMetadata;
    if (meta?.webSearchQueries?.length) {
      console.log("🔍 Search queries:", meta.webSearchQueries);
    } else {
      console.log(data);
    }

    res.json(data);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});