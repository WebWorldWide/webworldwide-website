declare global {
  namespace Express {
    interface Request {
      user?: {
        id?: string | number;
        username?: string;
        expires?: number;
        [key: string]: unknown;
      };
    }
  }
}

export {};
