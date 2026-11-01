/**
 * 内置应用凭证。
 *
 * Telegram 的 api_id / api_hash 是「应用」级凭证，不是「账号」级凭证。
 * 大量第三方工具（tdl、Telethon、Pyrogram 等）都内置了官方客户端的凭证，
 * 用户只需手机扫码或收验证码登录自己的账号即可，无需去 my.telegram.org 申请。
 *
 * 这里的取值来自 tdl 的 pkg/consts/telegram.go：
 *   AppBuiltin: iyear 自行申请（默认）
 *   AppDesktop: Telegram Desktop 官方客户端（id=2040，仅兜底，不推荐）
 *
 * 注意：使用内置凭证时，设备指纹必须与凭证声明的平台一致（Desktop），
 * 否则「平台不匹配」本身就是一个风控信号。
 *
 * 1.0.1 变更：默认凭据由官方 Desktop 换成 tdl 自建应用。
 * 原因见 README「账号风控与封禁」—— 用官方客户端凭证做自动化，
 * 会被判定为「冒充官方客户端」，代价是账号级处置。
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
  /**
   * 默认凭证：tdl 自行申请的应用（api_id 15055931）。
   *
   * 它不属于任何官方客户端，用它做自动化不会构成「冒充官方客户端」，
   * 风控画像比官方 Desktop 凭证干净得多，因此 1.0.1 起改为默认。
   */
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
  /**
   * 官方桌面客户端凭证（api_id 2040）。**不要用于自动化**：
   * 拿官方客户端的身份从机房 IP 批量下载，是「仿冒官方客户端」的典型画像，
   * 已实测会导致账号被重置全部会话、机器人被冻结。仅作兜底保留。
   */
  desktop: {
    apiId: 2040,
    apiHash: "b18441a1ff607e10a989891a5462e627",
    label: "Telegram Desktop（官方客户端，风控敏感）",
    device: {
      deviceModel: "Desktop",
      systemVersion: "Windows 10",
      appVersion: "4.2.4 x64",
      langCode: "en",
      systemLangCode: "en-US",
    },
  },
};

export const DEFAULT_BUILTIN_APP: BuiltinAppKey = "builtin";

export function getBuiltinApp(key: string | undefined | null): BuiltinApp {
  const k = (key ?? DEFAULT_BUILTIN_APP) as BuiltinAppKey;
  return BUILTIN_APPS[k] ?? BUILTIN_APPS[DEFAULT_BUILTIN_APP];
}
