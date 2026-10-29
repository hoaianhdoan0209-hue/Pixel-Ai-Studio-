import type { Express, Request, Response, NextFunction } from 'express';
import type { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, any>;
export interface ModuleContext {
  app: Express;
  db: DatabaseSync;
  dataDir: string;
  one: (sql: string, ...params: any[]) => Row | undefined;
  all: (sql: string, ...params: any[]) => Row[];
  run: (sql: string, ...params: any[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  transaction: <T>(fn: () => T) => T;
  authenticated: (req: Request, res: Response, next: NextFunction) => unknown;
  uid: (res: Response) => string;
  route: (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => void;
  getProject: (projectId: string, res: Response, edit?: boolean) => Row;
  manageProject: (project: Row) => void;
  ownProject: (project: Row) => void;
  notify: (userId: string, type: string, title: string, href: string) => unknown;
  audit: (actor: string, project: string | null, action: string, detail?: string) => unknown;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
