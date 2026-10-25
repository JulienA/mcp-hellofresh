import { Server } from "@modelcontextprotocol/server";
import type { HelloFreshSession } from "./hellofresh-session.js";
export interface HelloFreshMCPServerOptions {
    /** False for HTTP/headless deployments — the login tool must not open a browser. */
    allowInteractiveLogin?: boolean;
}
export declare class HelloFreshMCPServer {
    readonly server: Server;
    private readonly session;
    private readonly allowInteractiveLogin;
    constructor(session: HelloFreshSession, options?: HelloFreshMCPServerOptions);
    private setupHandlers;
    private notifyLoginWindow;
    private handleTool;
    runStdio(): Promise<void>;
}
//# sourceMappingURL=mcp-server.d.ts.map