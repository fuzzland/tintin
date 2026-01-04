import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "tintin_ui_token";

export function useAuthToken(): string | null {
  const [token, setToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("token");
    if (fromQuery) return fromQuery;
    return sessionStorage.getItem(STORAGE_KEY);
  });

  useEffect(() => {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
  }, [token]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("token");
    if (fromQuery && fromQuery !== token) {
      setToken(fromQuery);
    }
  }, [token]);

  return useMemo(() => token, [token]);
}
