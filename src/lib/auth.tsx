import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase';
import type { User, Session } from '@supabase/supabase-js';

export interface AppUser {
  id: string;
  auth_id: string | null;
  email: string;
  full_name: string | null;
  role: 'user' | 'admin';
  wallet_address?: string | null;
}

export interface OutletContext {
  user: AppUser | null;
}

interface AuthContextType {
  user: AppUser | null;
  session: Session | null;
  isLoading: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; sessionCreated?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: Error | null }>;
  updateProfile: (data: { full_name?: string }) => Promise<{ error: Error | null }>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const DB_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const lastLoadedAuthId = useRef<string | null>(null);

  const fetchAppUser = useCallback(async (authUser: User): Promise<AppUser> => {
    const minimal: AppUser = {
      id: authUser.id,
      auth_id: authUser.id,
      email: authUser.email!,
      full_name: authUser.user_metadata?.full_name ?? null,
      role: 'user',
    };

    try {
      type ProfileRow = Record<string, unknown>;

      const primaryPromise: Promise<ProfileRow | null> = Promise.resolve(
        supabase.from('users').select('*').eq('auth_id', authUser.id).maybeSingle()
      ).then(({ data }) => data as ProfileRow | null);

      let row = await withTimeout<ProfileRow | null>(primaryPromise, DB_TIMEOUT_MS, null);

      if (!row) {
        const fallbackPromise: Promise<ProfileRow | null> = Promise.resolve(
          supabase.from('users').select('*').eq('email', authUser.email!).maybeSingle()
        ).then(({ data }) => data as ProfileRow | null);
        row = await withTimeout<ProfileRow | null>(fallbackPromise, DB_TIMEOUT_MS, null);
      }

      if (row) {
        if (!row['auth_id']) {
          supabase
            .from('users')
            .update({ auth_id: authUser.id })
            .eq('id', row['id'])
            .then(() => {});
        }
        return { ...row, auth_id: row['auth_id'] ?? authUser.id } as unknown as AppUser;
      }

      supabase.from('users').upsert(
        {
          auth_id: authUser.id,
          email: authUser.email!,
          full_name: authUser.user_metadata?.full_name ?? null,
          role: 'user',
        },
        { onConflict: 'auth_id' }
      ).then(() => {
        supabase.from('user_balances').upsert(
          { user_email: authUser.email!, balance_usd: 0, total_invested: 0, total_profit_loss: 0 },
          { onConflict: 'user_email' }
        ).then(() => {});
      });

      console.warn('[Salarn] Profile row missing — using minimal user. Run SUPABASE-SCHEMA.sql to install trigger.');
      return minimal;

    } catch (err) {
      console.error('[Salarn] fetchAppUser error:', err);
      return minimal;
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const { data: { session: current } } = await supabase.auth.getSession();
    if (current?.user) {
      lastLoadedAuthId.current = null;
      const appUser = await fetchAppUser(current.user);
      setUser(appUser);
    }
  }, [fetchAppUser]);

  useEffect(() => {
    let mounted = true;

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      setSession(session);

      if (!session?.user) {
        lastLoadedAuthId.current = null;
        setUser(null);
        if (mounted) setIsLoading(false);
        return;
      }

      const isTokenRefresh = event === 'TOKEN_REFRESHED';
      if (isTokenRefresh && lastLoadedAuthId.current === session.user.id && user !== null) {
        if (mounted) setIsLoading(false);
        return;
      }

      lastLoadedAuthId.current = session.user.id;
      const appUser = await fetchAppUser(session.user);

      if (mounted) {
        setUser(appUser);
        setIsLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAppUser]);

  const signUp = async (email: string, password: string, fullName: string) => {
    try {
      const redirectTo = `${window.location.origin}/auth/callback`;
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectTo,
          data: { full_name: fullName },
        },
      });
      if (error) return { error: error as Error };
      if (data?.user && !data.user.identities?.length) {
        return { error: new Error('An account with this email already exists. Please sign in.') };
      }
      // If a session was returned, email confirmation is disabled in Supabase
      // and the user is already signed in — let the caller know so it can redirect.
      const sessionCreated = !!(data?.session);
      return { error: null, sessionCreated };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error as Error | null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const resetPassword = async (email: string) => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback`,
      });
      return { error: error as Error | null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signOut = async () => {
    lastLoadedAuthId.current = null;
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    setUser(null);
    setSession(null);
  };

  const updateProfile = async (data: { full_name?: string }) => {
    if (!user) return { error: new Error('Not authenticated') };
    try {
      const { error } = await supabase
        .from('users')
        .update({ ...data, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      if (!error) setUser(prev => prev ? { ...prev, ...data } : null);
      return { error: error as Error | null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  return (
    <AuthContext.Provider value={{ user, session, isLoading, signUp, signIn, signOut, resetPassword, updateProfile, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
