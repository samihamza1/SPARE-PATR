import { z } from 'zod';

/**
 * Length-based policy (NIST SP 800-63B): no composition rules, a minimum length, an upper
 * bound that keeps hashing cheap to reject, and a deny-list of the most common passwords.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// Small local deny-list; a larger breached-password check can replace it later.
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  '0987654321',
  '1111111111',
  '0000000000',
  '1234512345',
  '123456789a',
  'a123456789',
  'qwertyuiop',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'iloveyou12',
  'abcdefghij',
  'abc1234567',
  'qwerty1234',
  '1q2w3e4r5t',
  'zaq12wsxcde',
  'admin12345',
]);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { message: 'password.too_short' })
  .max(PASSWORD_MAX_LENGTH, { message: 'password.too_long' })
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), { message: 'password.too_common' });
