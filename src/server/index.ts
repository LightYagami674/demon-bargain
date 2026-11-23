import { routePartykitRequest } from "partyserver";
import { Room, type Env } from "./room.js";

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse) {
      return partyResponse;
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
