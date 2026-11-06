declare global {
  namespace Express {
    interface Request {
      /** Set by the /api session gate (see routes/auth.ts resolveSession). */
      user?: {
        userId: string;
        username: string;
        sessionId: string;
        method: string;
        createdAt: number;
      };
    }
  }
}

export {};
