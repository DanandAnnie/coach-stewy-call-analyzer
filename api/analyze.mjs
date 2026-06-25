export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
  }

  const { system, messages = [], max_tokens } = req.body || {};
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Translate the Anthropic-style payload the frontend sends into Gemini's format.
  const contents = messages.map(m => {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(b => b.text || "").join("\n")
        : "";
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text }] };
  });

  const body = {
    contents,
    // Force valid JSON output so the frontend's JSON.parse never chokes.
    generationConfig: {
      maxOutputTokens: max_tokens || 2000,
      responseMimeType: "application/json",
    },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  // Translate Gemini's response back so the frontend's content[].text parsing works unchanged.
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || "")
    .join("")
    .trim();
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "empty";
    return res.status(502).json({ error: `Model returned no text (${reason}). Try again or change GEMINI_MODEL.` });
  }
  res.status(200).json({ content: [{ type: "text", text }] });
}
