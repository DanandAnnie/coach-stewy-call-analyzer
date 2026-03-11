export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing API key" }), { status: 400 });
  }

  const body = await req.arrayBuffer();

  const res = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/octet-stream",
    },
    body,
  });

  const text = await res.text();
  try {
    JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: text }), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
};
