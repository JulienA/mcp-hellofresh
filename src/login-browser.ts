import { chromium } from "playwright";
import { parseApiV2Auth } from "./accounts.js";
import { helloFreshCountry } from "./countries.js";
import { HelloFreshApi, HelloFreshApiError, type FetchLike } from "./hellofresh-api.js";
import { assertInteractiveLoginAllowed } from "./login-mode.js";
import { isHelloFreshLoggedInUrl } from "./session.js";
import type { StoredAccount } from "./accounts.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Opens HelloFresh in a local window so the person can finish Google sign-in
 * themselves. Only the apiV2Auth token is kept. The Google password is never read.
 */
export async function captureHelloFreshAccount(input: {
  country: string;
  fetchImpl?: FetchLike;
  loginTimeoutMs?: number;
}): Promise<StoredAccount> {
  assertInteractiveLoginAllowed();
  const country = helloFreshCountry(input.country);
  if (!country) {
    throw new HelloFreshApiError("api", "Choose a HelloFresh country with HELLOFRESH_COUNTRY.");
  }
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${country.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + (input.loginTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (isHelloFreshLoggedInUrl(page.url())) {
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!isHelloFreshLoggedInUrl(page.url())) {
      throw new HelloFreshApiError(
        "api",
        "Timed out waiting for HelloFresh sign-in. Finish Continue with Google in the window, then run login again."
      );
    }
    const fromStorage = await page.evaluate(() => window.localStorage.getItem("apiV2Auth"));
    const cookies = await context.cookies();
    const fromCookie = cookies.find((cookie) => cookie.name === "apiV2Auth")?.value;
    const raw = fromStorage || fromCookie;
    const parsed = parseApiV2Auth(raw);
    if (!parsed) {
      throw new HelloFreshApiError(
        "invalid_token",
        "Signed in, but HelloFresh did not expose an apiV2Auth token to save."
      );
    }
    const api = await HelloFreshApi.fromPasted({
      token: raw ?? "",
      country: country.code,
      fetchImpl: input.fetchImpl,
      parsed,
    });
    return api.toStoredAccount();
  } finally {
    await browser.close();
  }
}
