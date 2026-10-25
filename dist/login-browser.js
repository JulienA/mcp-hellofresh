"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureHelloFreshAccount = captureHelloFreshAccount;
const playwright_1 = require("playwright");
const accounts_js_1 = require("./accounts.js");
const countries_js_1 = require("./countries.js");
const hellofresh_api_js_1 = require("./hellofresh-api.js");
const login_mode_js_1 = require("./login-mode.js");
const session_js_1 = require("./session.js");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Opens HelloFresh in a local window so the person can finish Google sign-in
 * themselves. Only the apiV2Auth token is kept. The Google password is never read.
 */
async function captureHelloFreshAccount(input) {
    (0, login_mode_js_1.assertInteractiveLoginAllowed)();
    const country = (0, countries_js_1.helloFreshCountry)(input.country);
    if (!country) {
        throw new hellofresh_api_js_1.HelloFreshApiError("api", "Choose a HelloFresh country with HELLOFRESH_COUNTRY.");
    }
    const browser = await playwright_1.chromium.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${country.baseUrl}/login`, { waitUntil: "domcontentloaded" });
        const deadline = Date.now() + (input.loginTimeoutMs ?? DEFAULT_TIMEOUT_MS);
        while (Date.now() < deadline) {
            if ((0, session_js_1.isHelloFreshLoggedInUrl)(page.url())) {
                break;
            }
            await page.waitForTimeout(500);
        }
        if (!(0, session_js_1.isHelloFreshLoggedInUrl)(page.url())) {
            throw new hellofresh_api_js_1.HelloFreshApiError("api", "Timed out waiting for HelloFresh sign-in. Finish Continue with Google in the window, then run login again.");
        }
        const fromStorage = await page.evaluate(() => window.localStorage.getItem("apiV2Auth"));
        const cookies = await context.cookies();
        const fromCookie = cookies.find((cookie) => cookie.name === "apiV2Auth")?.value;
        const raw = fromStorage || fromCookie;
        const parsed = (0, accounts_js_1.parseApiV2Auth)(raw);
        if (!parsed) {
            throw new hellofresh_api_js_1.HelloFreshApiError("invalid_token", "Signed in, but HelloFresh did not expose an apiV2Auth token to save.");
        }
        const api = await hellofresh_api_js_1.HelloFreshApi.fromPasted({
            token: raw ?? "",
            country: country.code,
            fetchImpl: input.fetchImpl,
            parsed,
        });
        return api.toStoredAccount();
    }
    finally {
        await browser.close();
    }
}
//# sourceMappingURL=login-browser.js.map