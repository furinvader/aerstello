import type { Language, LocalizedText } from '@sky-bar/shared';
export type { OrderItem, Tab } from '@sky-bar/shared';

export interface Host { id: string; email: string; name: string; role: 'admin' | 'staff'; language: Language; version: number; sessionId: string }
export interface Venue { name: string; defaultLanguage: Language; timezone: string; version: number }
export interface Room { id: string; name: string; position: number; guestCount?: number; version: number }
export interface Guest { id: string; name: string; roomId: string; roomName: string; language: Language; itemCount: number; totalCents: number; version: number }
export interface Category { id: string; name: LocalizedText; position: number; version: number }
export interface Product { id: string; categoryId: string; name: LocalizedText; description?: LocalizedText; priceCents: number; enabled: boolean; selfServiceOnly: boolean; position: number; version: number }
export interface TabSummary { id: string; guestId: string; guestName: string; roomName: string; itemCount: number; totalCents: number; openedAt: string }
export interface Bill { id: string; number: string; venueName: string; venueTimezone: string; guestName: string; roomName: string; totalCents: number; paymentMethod: string; settledAt: string; voidedAt?: string }
export interface AccessRequest { id: string; name: string; roomId: string; roomName: string; language: Language; status: string; requestedAt: string }
