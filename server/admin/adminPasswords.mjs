import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** 后台口令最短长度。太短的口令挡不住撞库，接口与前端用同一个常量提示。 */
export const ADMIN_PASSWORD_MINIMUM_LENGTH = 8;

/**
 * 口令哈希：`scrypt$<盐 base64url>$<派生密钥 base64url>`。
 *
 * 服务端从不保存明文：落盘的只有这串哈希，接口也从不回传它。
 */
export async function hashAdminPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/**
 * 校验口令。
 *
 * 比对走 timingSafeEqual：逐字符比较会把「前几位对不对」写进响应时间，
 * 攻击者可以据此一位一位地猜口令。
 */
export async function verifyAdminPassword(hash, password) {
  const [scheme, saltText, keyText] = String(hash ?? '').split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;

  let expected;
  try {
    expected = Buffer.from(keyText, 'base64url');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await deriveKey(String(password), Buffer.from(saltText, 'base64url'), KEY_LENGTH);
  return timingSafeEqual(derived, expected);
}
