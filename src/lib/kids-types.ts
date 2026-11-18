/** Kids mode settings (`user_settings.kids`, migration 20261118130000). Pure types: imported by state/auth. */
export type KidsConfig = {
  on: boolean;
  /** Parent PIN: SHA-256(salt + pin), hex. Set on this account; checked on the device. */
  pin_salt?: string;
  pin_hash?: string;
  /** Daily listening limit in minutes; 0 = no limit. */
  limit_min: number;
  bed_on: boolean;
  /** Bedtime window, minutes after midnight (e.g. 20:30 → 1230 until 07:00 → 420). */
  bed_from: number;
  bed_to: number;
};

export const KIDS_DEFAULTS: KidsConfig = { on: false, limit_min: 120, bed_on: true, bed_from: 20 * 60 + 30, bed_to: 7 * 60 };
