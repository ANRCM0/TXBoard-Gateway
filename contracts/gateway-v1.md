# TXBoard Gateway HTTP API — v1

> **实现状态：**以下接口已有 Gateway 源码与模拟 CI 支持（截至 2026-10-08）；真实 TXBoard/Laravel/MySQL/Redis 联调**尚未验收**。本合同仅描述 Gateway 的固定接口，不更改 TXBoard 原 `/api/v1/*`、`/api/v2/*`、`/s/*`。

## 请求与错误格式

- Base URL `/gateway/v1`，仅 Gateway 存活检查位于 `GET /healthz`。
- UTF-8 JSON、无 cookie、no-store；Origin 必须严格匹配已配置名单。它不是服务器认证机制。
- 成功：`{"ok":true,"data":{},"meta":{"version":"1","requestId":"..."}}`。
- 失败：`{"ok":false,"error":{"code":"...","message":"..."},"meta":{"version":"1","requestId":"..."}}`。
- 核心错误：400（入参）、401（缺 Token/上游未授权）、403（Origin）、404（未找到）、405（订单写入禁用）、409（HPKE 重放）、413（请求过大）、422（Laravel 校验）、429（账号限流或上游限流）、502/504（坏网关/超时）、503（Redis 安全存储不可用）、500（内部错误）。
- Laravel `{status:"success",data}` 被 Gateway 规范化；遗留 `{data:[],total:number}` 仅对需要分页列表的固定路径作兼容。错误正文不会原样公开上游内部信息。
- **权限判断始终以 Laravel 为准**。用户 GET 路由需 `Authorization: Bearer <user-token>`；无用户身份的页面不允许向 Gateway 提交管理员 Token。

## 固定路由矩阵

| 方法和路径（均加 `/gateway/v1` 前缀） | 认证 / 业务含义 | Laravel V1 上游 |
| --- | --- | --- |
| GET `/bootstrap` | 公共站点、主题、CAPTCHA 公开元数据、能力清单 | `guest/comm/config` |
| GET `/theme/config` | 公开主题配置 | `guest/comm/config` |
| GET `/plans` | 公开套餐列表；金额遵循 Laravel 分单位 | `guest/plan/fetch` |
| POST `/auth/login` | 邮箱/密码、可选 CAPTCHA；兼容普通登录 | `passport/auth/login` |
| GET `/user/profile` | 用户资料 | `user/info` |
| GET `/user/subscription/summary` | 订阅使用概览，不返回 token/uuid/subscribe_url | `user/getSubscribe` |
| GET `/dashboard/stats` | `{unpaidOrders,openTickets,invitedUsers}` | `user/getStat` |
| GET `/orders` | 当前用户订单数组；可选 status=0/1/2/3 | `user/order/fetch` |
| GET `/orders/:tradeNo` | 当前用户的订单详情 | `user/order/detail?trade_no=` |
| GET `/orders/:tradeNo/status` | `{tradeNo,status}`，仅查询状态 | `user/order/check?trade_no=` |
| GET `/payments` | 已启用的支付方式**展示字段**，非交易入口 | `user/order/getPaymentMethod` |
| GET `/notices?current=1&pageSize=5` | 当前用户通知分页 `{data,total}`；最大 pageSize=100 | `user/notice/fetch` |
| GET `/crypto/key` | 仅启用 HPKE 时公开 kid/suite/公钥/scope | Gateway 本地 |
| POST `/secure/auth/login` | 启用 HPKE+Redis 时密文登录 | `passport/auth/login` |
| POST `/secure/auth/register` | **默认关闭**，需 HPKE+Redis 和账户开关 | `passport/auth/register` |
| POST `/secure/auth/email-code` | **默认关闭**，需 HPKE+Redis 和账户开关 | `passport/comm/sendEmailVerify` |
| POST `/orders` | **405，未实现写入** | 无 |

仅支付方式展示使用用户 Bearer，不代表任何“访客支付方式”已开放。

## 关键输入/输出约束

**bootstrap** 的 CAPTCHA 结构：
`security.captcha={enabled:boolean,type:'turnstile'|'recaptcha'|'recaptcha-v3'|null,siteKey:string|null}`。当 enabled=true 但类型/key 缺失，前端必须阻止未经验证码的登录，而不是静默禁用。

**明文登录**：`{email,password,turnstile_token?,recaptcha_v3_token?,recaptcha_data?,email_code?}`。返回只含 `auth_data` 及可选 `is_admin`；故意移除 Laravel 的 `secure_path` 和遗留 `token`。

**密文账户操作**：Gateway 公钥发现后使用 HPKE 请求体 `{kid,ts,nonce,enc,ct}`。AAD 绑定 `login`/`register`/`email-code` 的固定路径；密文不可跨操作直接重放。注册字段 `{email,password,invite_code?,email_code?,turnstile_token?,recaptcha_v3_token?,recaptcha_data?}`，发邮箱码字段 `{email,turnstile_token?,recaptcha_v3_token?,recaptcha_data?}`。成功注册只返回用户 `auth_data` 和可选 `is_admin`；邮箱码返回 `{sent:true}`。SDK 不把失败自动降级为明文注册/发码。

**只读接口**：计划需 id/name；用户需 email；订单需 trade_no/status；付款仅公开 id/name/icon/payment/手续费字段；通知页限制 current 和 pageSize；统计固定是三个非负整数。错误或格式不符时拒绝而非强行透传。

## 界限

- Gateway 不代理任意 host/path，不直连数据库，不碰管理员/节点/插件/支付回调和订阅原文 Token。
- Redis nonce 是有限时间窗的防重放，不是 Laravel 交易幂等、不提供跨 Redis failover 的强一致承诺。
- 真实环境 fixtures、OpenAPI 3.1、完整安全审查和正式部署验收仍待完成。

[当前代码/CI 状态](../docs/development-status.md) · [HPKE/Redis 设计](../docs/app-crypto-preview.md) · [主题 SDK](../packages/theme-sdk/README.md)。
