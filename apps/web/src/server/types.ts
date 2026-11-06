/** An authenticated admin session, as stored in the `session` table. */
export type Session = {
  id: string;
  sub: string;
  name: string;
  groups: string[];
  expiresAt: Date;
};

/** Hono environment shared by every router: request-scoped values only. */
export type AppEnv = {
  Variables: {
    session: Session;
    requestId: string;
  };
};
