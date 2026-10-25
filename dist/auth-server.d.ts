import type { AccountLinker } from "./account-linker.js";
import { type HttpRuntimeConfig } from "./config.js";
export interface AuthorizationServer {
    handler: (request: Request) => Promise<Response>;
    jwksUrl: URL;
    issuer: string;
    close: () => void;
}
export interface AuthorizationServerOptions {
    accessTokenExpiresIn?: number;
}
export declare function createAuthorizationServer(config: HttpRuntimeConfig, linker: AccountLinker, options?: AuthorizationServerOptions): Promise<AuthorizationServer>;
export declare function isAuthorizationServerPath(pathname: string): boolean;
//# sourceMappingURL=auth-server.d.ts.map