/**
 * 内置应用凭证。
 *
 * Telegram 的 api_id / api_hash 是「应用」级凭证，不是「账号」级凭证。
 * 大量第三方工具（tdl、Telethon、Pyrogram 等）都内置了官方客户端的凭证，
 * 用户只需手机扫码或收验证码登录自己的账号即可，无需去 my.telegram.org 申请。
 *
 * 这里的取值来自 tdl 的 pkg/consts/telegram.go：
 *   AppBuiltin: iyear 自行申请
 *   AppDesktop: Telegram Desktop 官方客户端（id=2040）
 *
 * 注意：使用内置凭证时，设备指纹必须与凭证声明的平台一致（Desktop），
 * 否则「平台不匹配」本身就是一个风控信号。
 */

export type BuiltinAppKey = "desktop" | "builtin";

export interface BuiltinApp {
  apiId: number;
  apiHash: string;
  /** 展示给用户的名称 */
  label: string;
  /** 与该凭证匹配的设备指纹 */
  device: {
    deviceModel: string;
    systemVersion: string;
    appVersion: string;
    langCode: string;
    systemLangCode: string;
  };
}

export const BUILTIN_APPS: Record<BuiltinAppKey, BuiltinApp> = {
  desktop: {
    apiId: 2040,
    apiHash: "b18441a1ff607e10a989891a5462e627",
    label: "Telegram Desktop（官方客户端）",
    device: {
      deviceModel: "Desktop",
      systemVersion: "Windows 10",
      appVersion: "4.2.4 x64",
      langCode: "en",
      systemLangCode: "en-US",
    },
  },
  builtin: {
    apiId: 15055931,
    apiHash: "021d433426cbb920eeb95164498fe3d3",
    label: "tdl 内置应用",
    device: {
      deviceModel: "Desktop",
      systemVersion: "Windows 10",
      appVersion: "4.2.4 x64",
      langCode: "en",
      systemLangCode: "en-US",
    },
  },
};

export const DEFAULT_BUILTIN_APP: BuiltinAppKey = "desktop";

export function getBuiltinApp(key: string | undefined | null): BuiltinApp {
  const k = (key ?? DEFAULT_BUILTIN_APP) as BuiltinAppKey;
  return BUILTIN_APPS[k] ?? BUILTIN_APPS[DEFAULT_BUILTIN_APP];
}
