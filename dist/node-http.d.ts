import type { IncomingMessage, ServerResponse } from "node:http";
export declare function toWebRequest(req: IncomingMessage, publicOrigin: URL): Request;
export declare function sendWebResponse(res: ServerResponse, response: Response): Promise<void>;
//# sourceMappingURL=node-http.d.ts.map