/**
 * 应用版本号。
 *
 * 唯一来源是构建期注入的 `APP_VERSION`（Dockerfile 里 `ENV APP_VERSION=...`），
 * 没有注入时退回到这里的字面量 —— 两者必须一起改，改版本时检查：
 *   package.json / server/package.json / web/package.json / Dockerfile / 本文件
 *
 * 用它而不是各处硬编码，是为了 `/api/health`、设置页展示、镜像标签
 * 三处永远说同一个数字。
 */
export const APP_VERSION = process.env.APP_VERSION || "1.2.0";
