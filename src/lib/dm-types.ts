/** Minimal track shape stored in message/track jsonb (same keys the player's Track uses). */
export type TrackLike = { id: string; title: string; artist: string; artwork?: string | null; duration?: number; [k: string]: unknown };
