import type { LoginCredentials } from "./credentialService.js";

/**
 * Pre-login for Playwright runs.
 *
 * Generated scripts often start on a page that needs a session (e.g. /inventory.html) but
 * contain no login steps, so the site redirects them to its login page and every locator
 * times out. Before such a case runs, a Playwright globalSetup logs in once with the job's
 * credentials and saves the session as storageState, so the test starts already logged in.
 */

export const PRE_LOGIN_SETUP_FILE = "pre-login.setup.ts";

/** Environment variables read by the generated globalSetup file. */
export const PRE_LOGIN_ENV = {
  url: "PRE_LOGIN_URL",
  statePath: "PRE_LOGIN_STATE_PATH",
} as const;

/**
 * A case gets pre-login when the job has credentials and the script does not log in by
 * itself. Scripts that read TEST_PASSWORD are login tests: they must start logged out.
 */
export const shouldPreLogin = (script: string, credentials: LoginCredentials | null | undefined): boolean =>
  Boolean(credentials) && !/process\.env\.TEST_PASSWORD\b/.test(script);

/**
 * Source of the globalSetup file. It finds the login form generically: the first visible
 * password field, plus the last visible text/email/tel input before it (in the same form
 * when there is one). Credentials come from TEST_EMAIL / TEST_PASSWORD, never the file.
 */
export const PRE_LOGIN_SETUP_SOURCE = `import { chromium } from '@playwright/test';

const PASSWORD_SELECTOR = 'input[type="password"]:visible';
const LOGIN_PATHS = ['/login', '/signin', '/sign-in', '/account/login', '/auth/login'];
const LOGIN_LINK_PATTERN = '(log-?in|sign-?in|เข้าสู่ระบบ|ลงชื่อเข้าใช้)';

export default async function preLogin(): Promise<void> {
  const targetUrl = process.env.${PRE_LOGIN_ENV.url} ?? '';
  const statePath = process.env.${PRE_LOGIN_ENV.statePath} ?? '';
  const username = process.env.TEST_EMAIL ?? '';
  const password = process.env.TEST_PASSWORD ?? '';
  if (!targetUrl || !statePath || !username || !password) {
    throw new Error('Pre-login: missing target URL, state path or credentials');
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // The target page usually redirects to the login form; otherwise try the site root, then a
    // login link seen on those pages, then common login paths.
    const origin = new URL(targetUrl).origin;
    const candidates = [targetUrl, origin + '/'];
    const tried = new Set<string>();
    let foundForm = false;
    for (let index = 0; index < candidates.length && index < 8; index += 1) {
      const url = candidates[index];
      if (tried.has(url)) continue;
      tried.add(url);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await page.locator(PASSWORD_SELECTOR).first().waitFor({ state: 'visible', timeout: 5_000 });
        foundForm = true;
        break;
      } catch {
        // No login form here; try the next candidate.
      }
      if (index === 1) {
        const loginLinks = await page.evaluate((loginPattern) => {
          const pattern = new RegExp(loginPattern, 'i');
          return Array.from(document.querySelectorAll('a[href]'))
            .filter((link) => link.getClientRects().length > 0)
            .filter((link) => pattern.test(link.getAttribute('href') ?? '') || pattern.test(link.textContent ?? ''))
            .map((link) => (link as HTMLAnchorElement).href)
            .filter((href) => href.startsWith(location.origin));
        }, LOGIN_LINK_PATTERN).catch(() => [] as string[]);
        candidates.push(...loginLinks.slice(0, 2), ...LOGIN_PATHS.map((path) => origin + path));
      }
    }
    if (!foundForm) {
      throw new Error('Pre-login: no login form (password field) found at ' + [...tried].join(' or '));
    }

    const passwordField = page.locator(PASSWORD_SELECTOR).first();
    const hasUsernameField = await passwordField.evaluate((passwordInput) => {
      const scope = passwordInput.closest('form') ?? document;
      const isVisible = (el: Element) => el.getClientRects().length > 0;
      const before = Array.from(scope.querySelectorAll('input')).filter((input) =>
        ['text', 'email', 'tel'].includes(input.type)
        && isVisible(input)
        && Boolean(input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING));
      const field = before.at(-1);
      if (!field) return false;
      field.setAttribute('data-pre-login-user', '');
      return true;
    });
    if (!hasUsernameField) {
      throw new Error('Pre-login: no username/email field found before the password field');
    }

    await page.locator('[data-pre-login-user]').fill(username);
    await passwordField.fill(password);
    await passwordField.press('Enter');

    const loginFormGone = async (timeout: number) => {
      try {
        await page.locator(PASSWORD_SELECTOR).first().waitFor({ state: 'hidden', timeout });
        return true;
      } catch {
        return false;
      }
    };

    if (!(await loginFormGone(5_000))) {
      // Some forms ignore Enter; click the submit button instead.
      const submit = page.locator('form:has(input[type="password"]) :is(button[type="submit"], input[type="submit"], button:not([type]))').first();
      if (await submit.count()) await submit.click();
      if (!(await loginFormGone(10_000))) {
        throw new Error('Pre-login: login form is still shown after submitting. Check the username/password on the setup page.');
      }
    }

    await page.waitForLoadState('domcontentloaded');
    // Let client-side auth (e.g. Firebase) finish writing its session before saving it.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    // indexedDB: sites like Firebase Auth keep the session there, not in cookies/localStorage.
    await context.storageState({ path: statePath, indexedDB: true });
  } finally {
    await browser.close();
  }
}
`;
