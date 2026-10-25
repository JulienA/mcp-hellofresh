import http from "node:http";
import { type AccountLinker } from "./account-linker.js";
import type { HttpRuntimeConfig } from "./config.js";
import type { FetchLike } from "./hellofresh-api.js";
export interface HttpServerHandle {
    server: http.Server;
    baseUrl: string;
    config: HttpRuntimeConfig;
    close: () => Promise<void>;
}
export interface HttpServerOptions {
    /** Injected in tests. Production uses the platform fetch. */
    fetchImpl?: FetchLike;
    /** Injected in tests. Production links accounts through /gw. */
    linker?: AccountLinker;
    /** Test-only override for JWT access-token lifetime. */
    accessTokenExpiresIn?: number;
}
export declare function startHttpServer(config: HttpRuntimeConfig, options?: HttpServerOptions): Promise<HttpServerHandle>;
//# sourceMappingURL=http.d.ts.map