/**
 * Express `Request` augmentations for properties this app's middleware adds.
 *
 * Without this, `req.jwtToken` is invisible to TypeScript on both sides of the
 * boundary: the middleware in `routes/linkedinInteractionRoutes.js` assigns it,
 * and `linkedinInteractionController.ts` had to read it back through an
 * `as unknown as Record<string, unknown>` double-cast.
 */
declare global {
  namespace Express {
    interface Request {
      /**
       * Bearer token extracted by the `authenticateJWT` middleware in
       * `routes/linkedinInteractionRoutes.js`. Present only on routes that
       * middleware guards.
       */
      jwtToken?: string;
    }
  }
}

export {};
