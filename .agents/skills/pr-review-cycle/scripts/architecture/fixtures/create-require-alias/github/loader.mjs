import { createRequire as makeRequire } from 'node:module';

export const require = makeRequire(import.meta.url);
