import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { clearUserClientData } from "@/lib/client-session-cleanup";
import { supabase } from "@/lib/supabase";

export type SongCraftUser = {
  id: string;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: "supabase";
  lastSignedIn: Date;
};

type AuthContextValue = {
  user: SongCraftUser | null;
  loading: boolean;
  error: Error | null;
  isAuthenticated: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const mapUser = (source: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null): SongCraftUser | null => source ? {
  id: source.id,
  openId: source.id,
  name: typeof source.user_metadata?.display_name === "string" ? source.user_metadata.display_name : "Temney",
  email: source.email ?? null,
  loginMethod: "supabase",
  lastSignedIn: new Date(),
} : null;

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SongCraftUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const queryClient = useQueryClient();
  const previousUserIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: authError } = await supabase.auth.getUser();
    setUser(mapUser(data.user));
    setError(authError ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(mapUser(session?.user ?? null));
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  // Auth state changes also cover token expiry and account switching, not only
  // the explicit logout button.
  useEffect(() => {
    const currentUserId = user?.id ?? null;
    const previousUserId = previousUserIdRef.current;
    if (previousUserId && previousUserId !== currentUserId) {
      void clearUserClientData(queryClient, previousUserId);
    }
    previousUserIdRef.current = currentUserId;
  }, [queryClient, user?.id]);

  const logout = useCallback(async () => {
    const userId = user?.id ?? null;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw signOutError;
    setUser(null);
    setError(null);
    await clearUserClientData(queryClient, userId);
  }, [queryClient, user?.id]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    error,
    isAuthenticated: Boolean(user),
    refresh,
    logout,
  }), [user, loading, error, refresh, logout]);

  return createElement(AuthContext.Provider, { value }, children);
}

/**
 * Jeden sdílený stav přihlášení pro celou appku.
 *
 * Dřív to byla volitelná hooka: `useAuth()` se volalo na 16 místech a
 * KAŽDÝ mount spustil vlastní `supabase.auth.getUser()` = 16 API requestů
 * jen na otevření obrazovky. Provider si stav drží jednou a všem ho
 * předá přes kontext - žádný call site se nemění.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth musí běžet pod AuthProviderem.");
  return context;
}

export function AuthProviderRoot({ children }: { children: ReactNode }) {
  return createElement(AuthProvider, null, children);
}
