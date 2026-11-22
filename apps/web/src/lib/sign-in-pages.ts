// The pages someone sees before signing in, and the modules that render each one. Shared by
// vite.config.ts, which gives these pages early requests and a smaller stylesheet, and the
// router, which loads the full stylesheet before leaving them.
declare global {
  interface Window {
    /** Loads the full stylesheet on sign-in pages; set by vite.config.ts. */
    __tfStyles?: () => Promise<void>;
  }
}

export const signInPages: Record<string, string[]> = {
  '/login': ['/src/pages/login.tsx'],
  '/register': ['/src/route-pages.ts', '/src/pages/auth.tsx'],
  '/login/forgot-password': ['/src/route-pages.ts', '/src/pages/password.tsx'],
  '/login/reset-password': ['/src/route-pages.ts', '/src/pages/password.tsx'],
};

export function isSignInPage(pathname: string) {
  return Object.hasOwn(signInPages, pathname.replace(/\/+$/, ''));
}
