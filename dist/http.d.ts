import http from "node:http";
import { HelloFreshBrowser } from "./browser.js";
import type { HttpRuntimeConfig } from "./config.js";
export interface HttpServerHandle {
    server: http.Server;
    baseUrl: string;
    config: HttpRuntimeConfig;
    close: () => Promise<void>;
}
export declare function startHttpServer(config: HttpRuntimeConfig, hellofresh?: HelloFreshBrowser): Promise<HttpServerHandle>;
//# sourceMappingURL=http.d.ts.map