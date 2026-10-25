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
export declare const HELLOFRESH_COUNTRIES: readonly HelloFreshCountry[];
export declare function helloFreshCountry(code: string | undefined): HelloFreshCountry | undefined;
//# sourceMappingURL=countries.d.ts.map