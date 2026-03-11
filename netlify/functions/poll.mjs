export default async (req) => {
  const url = new URL(req.url);
  const transcriptId = url.searchParams.get("id");
  const apiKey = req.headers.get("x-api-key");

  if (!transcriptId || !apiKey) {
    return new Response(JSON.stringify({ error: "Missing id or API key" }), { status: 400 });
  }

  const res = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
    headers: { authorization: apiKey },
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
};
