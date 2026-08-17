import type { Receipt } from './types.js';

export function receiptRank(receipt: Receipt | string | null | undefined): number;
export function strongerReceipt(a: Receipt, b: Receipt): Receipt;
export function walksBackwards(current: Receipt, next: Receipt): boolean;
