export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(400).json({ error: "Missing API key" });
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const response = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/octet-stream",
    },
    body,
  });

  const text = await response.text();
  try {
    JSON.parse(text);
  } catch {
    return res.status(response.status).json({ error: text });
  }
  res.status(response.status).setHeader("content-type", "application/json").send(text);
}

export const config = {
  api: {
    bodyParser: false,
  },
};
