import pg from 'pg';
import { config } from '../config.js';

export const db = new pg.Pool({ connectionString: config.databaseUrl, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
