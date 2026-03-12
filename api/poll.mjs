export default async function handler(req, res) {
  const { id } = req.query;
  const apiKey = req.headers["x-api-key"];

  if (!id || !apiKey) {
    return res.status(400).json({ error: "Missing id or API key" });
  }

  const response = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
    headers: { authorization: apiKey },
  });

  const data = await response.json();
  res.status(response.status).json(data);
}
