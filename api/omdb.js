export default async function handler(req, res) {
  const key = process.env.OMDB_KEY;
  if (!key) return res.status(500).json({ error: 'OMDB_KEY not configured' });

  const params = new URLSearchParams({ ...req.query, apikey: key });

  try {
    const response = await fetch(`https://www.omdbapi.com/?${params}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
