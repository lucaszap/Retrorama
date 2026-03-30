export default async function handler(req, res) {
  const key = process.env.TMDB_KEY;
  if (!key) return res.status(500).json({ error: 'TMDB_KEY not configured' });

  const params = new URLSearchParams({ ...req.query, api_key: key });

  try {
    const response = await fetch(`https://api.themoviedb.org/3/search/multi?${params}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
