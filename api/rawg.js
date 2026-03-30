export default async function handler(req, res) {
  const key = process.env.RAWG_KEY;
  if (!key) return res.status(500).json({ error: 'RAWG_KEY not configured' });

  const params = new URLSearchParams({ ...req.query, key });

  try {
    const response = await fetch(`https://api.rawg.io/api/games?${params}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
