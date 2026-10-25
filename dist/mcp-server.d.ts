import { Server } from "@modelcontextprotocol/server";
import { HelloFreshBrowser } from "./browser.js";
export interface HelloFreshMCPServerOptions {
    /** False for HTTP/headless deployments — the login tool must not open a browser. */
    allowInteractiveLogin?: boolean;
}
export declare class HelloFreshMCPServer {
    readonly server: Server;
    private readonly hellofresh;
    private readonly allowInteractiveLogin;
    constructor(hellofresh?: HelloFreshBrowser, options?: HelloFreshMCPServerOptions);
    private ensureInitialized;
    private setupHandlers;
    private notifyLoginWindow;
    private handleTool;
    runStdio(): Promise<void>;
}
//# sourceMappingURL=mcp-server.d.ts.map