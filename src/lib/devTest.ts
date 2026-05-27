/**
 * Dev-only test credential shortcut.
 *
 * Type the literal string "test" in any sign-in or master-password input and
 * we substitute the values from .env.local (VITE_DEV_TEST_*) before sending
 * the request. Stripped entirely from production builds — `import.meta.env.DEV`
 * is statically false in build, so Vite tree-shakes these branches away.
 *
 * Setup: add to .env.local (gitignored)
 *   VITE_DEV_TEST_EMAIL=you@example.com
 *   VITE_DEV_TEST_SIGNIN_PASSWORD=your-real-signin-password
 *   VITE_DEV_TEST_MASTER_PASSWORD=your-real-master-password
 */

export type DevTestField = 'email' | 'signinPassword' | 'masterPassword'

const TRIGGER = 'test'

function envFor(field: DevTestField): string | undefined {
  switch (field) {
    case 'email':
      return import.meta.env.VITE_DEV_TEST_EMAIL as string | undefined
    case 'signinPassword':
      return import.meta.env.VITE_DEV_TEST_SIGNIN_PASSWORD as string | undefined
    case 'masterPassword':
      return import.meta.env.VITE_DEV_TEST_MASTER_PASSWORD as string | undefined
  }
}

/**
 * Returns the real credential when:
 *   - We're in a dev build
 *   - The user typed exactly "test"
 *   - The matching env var is set
 * Otherwise returns the original input untouched.
 */
export function maybeSubstituteTestCred(input: string, field: DevTestField): string {
  if (!import.meta.env.DEV) return input
  if (input !== TRIGGER) return input
  const real = envFor(field)
  if (!real) {
    console.warn(
      `[devTest] "test" typed for ${field} but VITE_DEV_TEST_${field
        .replace(/[A-Z]/g, (m) => `_${m}`)
        .toUpperCase()} is not set in .env.local`,
    )
    return input
  }
  return real
}

export function isDevTestConfigured(): boolean {
  if (!import.meta.env.DEV) return false
  return Boolean(envFor('email') && envFor('signinPassword') && envFor('masterPassword'))
}
