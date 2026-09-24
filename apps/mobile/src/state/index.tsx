import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type {
  AnonymityMode,
  AttackConfig,
  TestCategory,
  TestDefinition,
  UserAccount,
} from '@teo/shared';
import { buildAllTestsConfigs, buildDefaultConfig, totalCreditCost } from '@teo/shared';

import { ApiError, api, loadBaseUrl, loadSession, saveSession, setBaseUrl } from '../api/client';

const CART_KEY = 'teo.cart';
const ANONYMITY_KEY = 'teo.anonymity';
const EGRESS_KEY = 'teo.egressProxy';

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

interface AuthState {
  user: UserAccount | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setLanguage: (language: 'en' | 'zh') => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<UserAccount | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      await loadBaseUrl();
      const session = await loadSession();
      if (session) {
        try {
          setUser(await api.me());
        } catch (err) {
          // Only discard the stored token when the server actually rejected it.
          //
          // This used to clear on ANY failure, so launching the app while the
          // server was unreachable (laptop asleep, different Wi-Fi, a proxy
          // answering 502) deleted a perfectly valid token from the Keychain
          // and forced a re-login. `ApiError.status` is 0 for a transport
          // failure and 401/403 only when the credential is genuinely dead.
          const status = err instanceof ApiError ? err.status : 0;
          if (status === 401 || status === 403) {
            await saveSession(null);
            setUser(null);
          }
        }
      }
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await api.login(email, password);
    setUser(session.user);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      /* keep the last known account */
    }
  }, []);

  const setLanguage = useCallback(async (language: 'en' | 'zh') => {
    await api.setLanguage(language);
    setUser((prev) => (prev ? { ...prev, language } : prev));
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, ready, signIn, signOut, refresh, setLanguage }),
    [user, ready, signIn, signOut, refresh, setLanguage],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

interface CatalogState {
  categories: TestCategory[];
  tests: TestDefinition[];
  testCount: number;
  ready: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const CatalogContext = createContext<CatalogState | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [categories, setCategories] = useState<TestCategory[]>([]);
  const [tests, setTests] = useState<TestDefinition[]>([]);
  const [testCount, setTestCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The catalog endpoint is authenticated, so it must be (re)fetched whenever
  // the signed-in operator changes. Fetching only on mount would run before
  // login completes, take a 401, and leave the Test tab permanently empty.
  const { user } = useAuth();

  const reload = useCallback(async () => {
    try {
      setError(null);
      const data = await api.catalog();
      setCategories(data.categories);
      setTests(data.tests);
      setTestCount(data.testCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      // Signed out: drop cached catalog data so a different operator never
      // sees the previous session's state.
      setCategories([]);
      setTests([]);
      setTestCount(0);
      setReady(false);
      return;
    }
    void reload();
  }, [user, reload]);

  const value = useMemo<CatalogState>(
    () => ({ categories, tests, testCount, ready, error, reload }),
    [categories, tests, testCount, ready, error, reload],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogState {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalog must be used inside <CatalogProvider>');
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Cart
 * ------------------------------------------------------------------ */

interface CartState {
  configs: AttackConfig[];
  ready: boolean;
  credits: number;
  /**
   * How the executor presents itself to the target. Chosen per run and
   * persisted, so every test added afterwards inherits it.
   */
  anonymity: AnonymityMode;
  setAnonymity: (mode: AnonymityMode) => void;
  egressProxy: string | null;
  setEgressProxy: (proxy: string | null) => void;
  add: (config: AttackConfig) => void;
  addDefaults: (testId: AttackConfig['testId'], domain: string) => AttackConfig;
  addAll: (domain: string) => AttackConfig[];
  update: (id: string, patch: Partial<AttackConfig>) => void;
  remove: (id: string) => void;
  clear: () => void;
  has: (testId: AttackConfig['testId']) => boolean;
}

const CartContext = createContext<CartState | null>(null);

export function CartProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [configs, setConfigs] = useState<AttackConfig[]>([]);
  const [ready, setReady] = useState(false);
  const [anonymity, setAnonymityState] = useState<AnonymityMode>('neutral');
  const [egressProxy, setEgressProxyState] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(CART_KEY);
        if (raw) setConfigs(JSON.parse(raw) as AttackConfig[]);
        const mode = await AsyncStorage.getItem(ANONYMITY_KEY);
        if (mode === 'identify' || mode === 'neutral' || mode === 'browser') {
          setAnonymityState(mode);
        }
        // Restore the proxy too. Without this the Identity card reported "no
        // proxy" after a restart while the restored cart items still carried
        // one — so the UI and the traffic disagreed about what the target saw.
        const proxy = await AsyncStorage.getItem(EGRESS_KEY);
        if (proxy) setEgressProxyState(proxy);
      } catch {
        /* start with an empty cart */
      }
      setReady(true);
    })();
  }, []);

  /** Apply the run-wide identity settings to a config before it is stored. */
  const applyIdentity = useCallback(
    (config: AttackConfig): AttackConfig => ({
      ...config,
      options: { ...config.options, anonymity, egressProxy },
    }),
    [anonymity, egressProxy],
  );

  const setAnonymity = useCallback((mode: AnonymityMode) => {
    setAnonymityState(mode);
    void AsyncStorage.setItem(ANONYMITY_KEY, mode);
    // Re-apply to everything already queued so the whole run is consistent.
    setConfigs((prev) => {
      const next = prev.map((c) => ({ ...c, options: { ...c.options, anonymity: mode } }));
      void AsyncStorage.setItem(CART_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setEgressProxy = useCallback((proxy: string | null) => {
    const cleaned = proxy && proxy.trim() ? proxy.trim() : null;
    setEgressProxyState(cleaned);
    void (cleaned
      ? AsyncStorage.setItem(EGRESS_KEY, cleaned)
      : AsyncStorage.removeItem(EGRESS_KEY));
    setConfigs((prev) => {
      const next = prev.map((c) => ({ ...c, options: { ...c.options, egressProxy: cleaned } }));
      void AsyncStorage.setItem(CART_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const add = useCallback(
    (config: AttackConfig) => {
      // Depends on applyIdentity: without it this closed over the identity
      // settings from the first render, so a test added after switching to
      // Browser mode would silently be queued as Neutral.
      const withIdentity = applyIdentity(config);
      setConfigs((prev) => {
        const next = [...prev, withIdentity];
        void AsyncStorage.setItem(CART_KEY, JSON.stringify(next));
        return next;
      });
    },
    [applyIdentity],
  );

  const addDefaults = useCallback(
    (testId: AttackConfig['testId'], domain: string) => {
      const config = applyIdentity(buildDefaultConfig(testId, domain));
      add(config);
      return config;
    },
    [add, applyIdentity],
  );

  /**
   * Add every test at once for the "Run All" flow. Tests already in the cart are
   * replaced rather than duplicated, so pressing it twice is not destructive.
   */
  const addAll = useCallback((domain: string) => {
    const fresh = buildAllTestsConfigs(domain).map(applyIdentity);
    setConfigs((prev) => {
      const withoutDuplicates = prev.filter((c) => c.target.domain !== domain);
      const next = [...withoutDuplicates, ...fresh];
      void AsyncStorage.setItem(CART_KEY, JSON.stringify(next));
      return next;
    });
    return fresh;
  }, [applyIdentity]);

  const update = useCallback(
    (id: string, patch: Partial<AttackConfig>) => {
      setConfigs((prev) => {
        const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
        void AsyncStorage.setItem(CART_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setConfigs((prev) => {
      const next = prev.filter((c) => c.id !== id);
      void AsyncStorage.setItem(CART_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setConfigs([]);
    void AsyncStorage.removeItem(CART_KEY);
  }, []);

  const has = useCallback(
    (testId: AttackConfig['testId']) => configs.some((c) => c.testId === testId),
    [configs],
  );

  const value = useMemo<CartState>(
    () => ({
      configs,
      ready,
      credits: totalCreditCost(configs),
      anonymity,
      setAnonymity,
      egressProxy,
      setEgressProxy,
      add,
      addDefaults,
      addAll,
      update,
      remove,
      clear,
      has,
    }),
    [
      configs,
      ready,
      anonymity,
      setAnonymity,
      egressProxy,
      setEgressProxy,
      add,
      addDefaults,
      addAll,
      update,
      remove,
      clear,
      has,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}

/* ------------------------------------------------------------------ *
 * API endpoint override
 * ------------------------------------------------------------------ */

export function useApiBaseUrl(): [string, (url: string) => Promise<void>] {
  const [url, setUrl] = useState('');
  useEffect(() => {
    void loadBaseUrl().then(setUrl);
  }, []);
  const update = useCallback(async (next: string) => {
    await setBaseUrl(next);
    setUrl(next);
  }, []);
  return [url, update];
}
