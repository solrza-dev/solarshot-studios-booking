import { handleRequest } from "./bookings";

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
