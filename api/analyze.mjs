export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing OPENROUTER_API_KEY" });
  }

  const { system, messages = [], max_tokens } = req.body || {};

  // Translate the Anthropic-style payload the frontend sends into OpenAI chat format.
  const chatMessages = [];
  if (system) chatMessages.push({ role: "system", content: system });
  for (const m of messages) {
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(b => b.text || "").join("\n")
        : "";
    chatMessages.push({ role: m.role, content });
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      max_tokens,
      messages: chatMessages,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  // Translate the OpenAI-style response back so the frontend's content[].text parsing works unchanged.
  let text = data.choices?.[0]?.message?.content || "";
  // Some reasoning models wrap their thinking in <think>...</think>; strip it before the frontend parses JSON.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) {
    return res.status(502).json({ error: "Model returned an empty response. Try again or change OPENROUTER_MODEL." });
  }
  res.status(200).json({ content: [{ type: "text", text }] });
}
