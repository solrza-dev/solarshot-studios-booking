import { handleRequest } from "./bookings";

export { BookingRequestLimiter, CalApiBudget } from "./rate-limiter";

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
