import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export function useGames() {
  const [games, setGames] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/games");
      setGames(data.games || []);
      setFavorites(data.favorites || []);
      setRecent(data.recent || []);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFavorite = useCallback(async (slug) => {
    try {
      const { data } = await api.post(`/games/${slug}/favorite`);
      setFavorites(data.favorites || []);
      return data;
    } catch (e) {
      return null;
    }
  }, []);

  return { games, favorites, recent, loading, error, reload: load, toggleFavorite };
}
