import crypto from "node:crypto";

/**
 * 口令哈希：Node 自带的 scrypt，不引第三方依赖。
 *
 * 为什么不用 bcrypt / argon2：两者都是需要编译的原生模块，而这个镜像已经背着
 * better-sqlite3 与 playwright，再加一个只为「存一个管理员密码」的原生依赖不划算。
 * scrypt 是 RFC 7914 标准算法，本身抗内存型硬件暴力破解，参数取 N=16384 时
 * 单次校验约 60ms —— 对人无感，对爆破足够慢。
 *
 * 落盘格式：scrypt$N$r$p$<salt-base64>$<hash-base64>
 * 参数一起存进去，将来调高强度时老密码仍能校验（按记录里的参数算）。
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function scryptAsync(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem 必须显式给：默认上限 32MB，N=16384/r=8 恰好踩在边界上会直接报错
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      keylen,
      { N, r, p, maxmem: 256 * N * r },
      (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * 校验口令。格式不认识、字段缺失一律返回 false，不抛错 ——
 * 库里躺着一行坏数据不该让登录接口 500，那会误导用户以为服务挂了。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (N <= 1 || r <= 0 || p <= 0 || N > 1 << 20) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scryptAsync(password, salt, N, r, p, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 输入校验（纯函数，自检直接调）                                        */
/* ------------------------------------------------------------------ */

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** 返回问题描述，没问题返回 null */
export function usernameProblem(raw: unknown): string | null {
  const name = String(raw ?? "").trim();
  if (!name) return "请输入用户名";
  if (name.length < USERNAME_MIN) return `用户名至少 ${USERNAME_MIN} 个字符`;
  if (name.length > USERNAME_MAX) return `用户名最多 ${USERNAME_MAX} 个字符`;
  if (/\s/.test(name)) return "用户名不能包含空格";
  // 允许中文、字母、数字、下划线、点、连字符
  if (!/^[\w.\-\u4e00-\u9fa5]+$/.test(name)) return "用户名只能包含中文、字母、数字、下划线、点或连字符";
  return null;
}

/**
 * 密码强度。
 *
 * 太严格的口令规则在这个场景里只会把人逼去用 `admin123`，所以这里只拦
 * 「短」与「纯重复/纯顺序」两类真正没有熵的情况，其余交给长度说话。
 */
export function passwordProblem(raw: unknown): string | null {
  const password = String(raw ?? "");
  if (!password) return "请输入密码";
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  if (/^(.)\1+$/.test(password)) return "密码不能是同一个字符重复";
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(password) && password.length < 12) {
    return "密码太容易被猜到，请换一个";
  }
  return null;
}

/** 改了密码就该让旧会话立刻失效（换了设备登录正是为了踢掉别人） */
export function confirmProblem(password: unknown, confirm: unknown): string | null {
  if (String(password ?? "") !== String(confirm ?? "")) return "两次输入的密码不一致";
  return null;
}
