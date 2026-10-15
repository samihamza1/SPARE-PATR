import type { MeResponse, Permission } from '@autoparts/shared';
import { isSupportedLocale } from '@autoparts/shared/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import { api, isUnauthenticated } from './api';

export const ME_KEY = ['me'] as const;

interface AuthValue {
  me: MeResponse | null;
  loading: boolean;
  /** True after the user signed out on purpose (vs. an expired session). */
  signedOut: boolean;
  can: (permission: Permission) => boolean;
  login: (input: { tenant: string; username: string; password: string }) => Promise<MeResponse>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Remembered on this browser so staff type the shop code once. */
export const SHOP_CODE_KEY = 'autoparts.shopCode';
export const LANGUAGE_KEY = 'autoparts.language';

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();
  const [signedOut, setSignedOut] = useState(false);

  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: () =>
      api<MeResponse>('GET', '/auth/me').catch((error: unknown) => {
        if (isUnauthenticated(error)) return null;
        throw error;
      }),
    staleTime: 60_000,
  });
  const me = meQuery.data ?? null;

  // The user's language, else the tenant default, unless this browser chose one.
  useEffect(() => {
    if (me === null || localStorage.getItem(LANGUAGE_KEY) !== null) return;
    const preferred = me.user.locale ?? me.tenant.defaultLocale;
    if (isSupportedLocale(preferred) && preferred !== i18n.language) {
      void i18n.changeLanguage(preferred);
    }
  }, [me, i18n]);

  const loginMutation = useMutation({
    mutationFn: (input: { tenant: string; username: string; password: string }) =>
      api<MeResponse>('POST', '/auth/login', input),
    onSuccess: (data, input) => {
      setSignedOut(false);
      localStorage.setItem(SHOP_CODE_KEY, input.tenant);
      queryClient.setQueryData(ME_KEY, data);
    },
  });

  const value: AuthValue = {
    me,
    loading: meQuery.isPending,
    signedOut,
    can: (permission) => me?.permissions.includes(permission) ?? false,
    login: (input) => loginMutation.mutateAsync(input),
    logout: async () => {
      await api('POST', '/auth/logout').catch(() => undefined);
      setSignedOut(true);
      // Update the observed `me` query in place (clear() would detach its observer and leave
      // the old user on screen), then drop everything cached for the previous user.
      queryClient.setQueryData(ME_KEY, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth outside AuthProvider');
  return value;
}

/**
 * Signed-in users only. After an expired session the user comes back to the same page
 * after signing in; after a deliberate sign-out the next user starts at home.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading, signedOut } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (me === null) {
    return <Navigate to="/login" replace state={signedOut ? null : { from: location.pathname }} />;
  }
  return children;
}
