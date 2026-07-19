import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);

  const refreshUser = useCallback(async () => {
    const token = localStorage.getItem("fg_token");
    if (!token) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const { data } = await api.get("/auth/me");
      setUser(data.user);
      return data.user;
    } catch (e) {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const { data } = await api.get("/system/config");
      setConfig(data);
      return data;
    } catch (e) {
      return null;
    }
  }, []);

  useEffect(() => {
    refreshUser();
    refreshConfig();
  }, [refreshUser, refreshConfig]);

  // Apply accessibility body classes from user settings
  useEffect(() => {
    const s = user?.settings || {};
    document.body.classList.toggle("rm", !!s.reduced_motion);
    document.body.classList.toggle("hc", !!s.high_contrast);
  }, [user]);

  const login = useCallback((token, u) => {
    localStorage.setItem("fg_token", token);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("fg_token");
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, loading, login, logout, refreshUser, config, refreshConfig }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
