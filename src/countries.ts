/** HelloFresh markets and the API country/locale codes the website sends. */

export interface HelloFreshCountry {
  /** Config key, also the value submitted on the authorize form. */
  code: string;
  label: string;
  baseUrl: string;
  /** ISO code the /gw query expects. The UK site uses `uk` but the API expects `GB`. */
  apiCountry: string;
  locale: string;
}

export const HELLOFRESH_COUNTRIES: readonly HelloFreshCountry[] = [
  { code: "us", label: "United States", baseUrl: "https://www.hellofresh.com", apiCountry: "US", locale: "en-US" },
  { code: "ca", label: "Canada", baseUrl: "https://www.hellofresh.ca", apiCountry: "CA", locale: "en-CA" },
  { code: "uk", label: "United Kingdom", baseUrl: "https://www.hellofresh.co.uk", apiCountry: "GB", locale: "en-GB" },
  { code: "au", label: "Australia", baseUrl: "https://www.hellofresh.com.au", apiCountry: "AU", locale: "en-AU" },
  { code: "nz", label: "New Zealand", baseUrl: "https://www.hellofresh.co.nz", apiCountry: "NZ", locale: "en-NZ" },
  { code: "de", label: "Germany", baseUrl: "https://www.hellofresh.de", apiCountry: "DE", locale: "de-DE" },
  { code: "at", label: "Austria", baseUrl: "https://www.hellofresh.at", apiCountry: "AT", locale: "de-AT" },
  { code: "ch", label: "Switzerland", baseUrl: "https://www.hellofresh.ch", apiCountry: "CH", locale: "de-CH" },
  { code: "nl", label: "Netherlands", baseUrl: "https://www.hellofresh.nl", apiCountry: "NL", locale: "nl-NL" },
  { code: "be", label: "Belgium", baseUrl: "https://www.hellofresh.be", apiCountry: "BE", locale: "nl-BE" },
  { code: "lu", label: "Luxembourg", baseUrl: "https://www.hellofresh.lu", apiCountry: "LU", locale: "fr-LU" },
  { code: "fr", label: "France", baseUrl: "https://www.hellofresh.fr", apiCountry: "FR", locale: "fr-FR" },
  { code: "ie", label: "Ireland", baseUrl: "https://www.hellofresh.ie", apiCountry: "IE", locale: "en-IE" },
  { code: "dk", label: "Denmark", baseUrl: "https://www.hellofresh.dk", apiCountry: "DK", locale: "da-DK" },
  { code: "no", label: "Norway", baseUrl: "https://www.hellofresh.no", apiCountry: "NO", locale: "nb-NO" },
  { code: "se", label: "Sweden", baseUrl: "https://www.hellofresh.se", apiCountry: "SE", locale: "sv-SE" },
];

export function helloFreshCountry(code: string | undefined): HelloFreshCountry | undefined {
  if (!code) {
    return undefined;
  }
  const normalized = code.trim().toLowerCase();
  return HELLOFRESH_COUNTRIES.find((country) => country.code === normalized);
}
