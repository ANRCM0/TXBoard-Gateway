# TXBoard V1 实际源码契约盘点（GW-101 / GW-102 前置）

> 状态：**源代码核对完成首轮，未采集真实环境响应**。核对仓库：
> [ANRCM0/TXBoard](https://github.com/ANRCM0/TXBoard) main（2026-10-08）。
> 这里的样例只是**根据源码编写的脱敏契约样例**，不是来自生产站点或 staging 的抓包。
> GW-101 的正式验收仍需真实 Laravel/MySQL/Redis 环境与浏览器 E2E 证据。

## 1. 路由、响应、权限矩阵

| Gateway API | Laravel 源文件 | 权限 / 原始路径 | 主要响应 |
| --- | --- | --- | --- |
| `GET /bootstrap` | `api/app/Http/Controllers/V1/Guest/CommController.php` | 访客 `/api/v1/guest/comm/config` | `status:success` 的 `data`：`app_name`, `app_description`, `app_url`, `logo`, `frontend_theme`, `theme_config`，以及公共验证码开关/类型/Site Key |
| `GET /theme/config` | 同上 + `api/app/Services/ThemeService.php::getPublicConfig` | 访客，同上 | 只有服务端通过主题 manifest 公共字段过滤的 `theme_config`；Gateway 不允许任意 guest config 字段穿透 |
| `GET /plans` | `api/app/Http/Controllers/V1/Guest/PlanController.php`, `api/app/Http/Resources/PlanResource.php` | 访客 `/api/v1/guest/plan/fetch` | 计划列表数组；`id` 整数、`name` 字符串；价格（含 `month_price` 等）保持 Laravel 的乘以 100 转换结果，不再重复换算 |
| `POST /auth/login` | `api/app/Http/Controllers/V1/Passport/AuthController.php`, `api/app/Services/AuthService.php` | 访客 `/api/v1/passport/auth/login` | 成功 `auth_data: 'Bearer ...'`; 后端也可能带 `is_admin`、`token`，管理员还带 `secure_path`。Gateway 只放行 `auth_data` 和 `is_admin` |
| `GET /user/profile` | `api/app/Http/Routes/V1/UserRoute.php` | Sanctum `/api/v1/user/info` | 含 `email` 的对象，其他字段为可扩展用户资料 |
| `GET /orders` | `api/app/Http/Controllers/V1/User/OrderController.php`, `OrderResource.php` | Sanctum `/api/v1/user/order/fetch` | **数组非分页器**，`trade_no` 和整数 `status` 为最小识别字段；仅支持 0/1/2/3 状态过滤 |

正常 Laravel Controller 的 `success()` 返回 `{status:'success',message,data,error}`；
`fail()` 返回 `status:'fail'`，业务错误的真实 HTTP status 由 ResponseEnum 决定。
历史独立分页器格式为 `{data:[],total:number,...}`，当前六个路由不依赖此格式。
来源：`api/app/Helpers/ApiResponse.php`。

## 2. 验证码字段（只读，公开）

Laravel `guest/comm/config` 提供以下可安全映射到 `bootstrap.security.captcha` 的**公开字段**：

| `captcha_type` | `bootstrap.security.captcha.type` | 公开站点 key | 登录提交字段 |
| --- | --- | --- | --- |
| `turnstile` | `turnstile` | `turnstile_site_key` | `turnstile_token` |
| `recaptcha` (v2) | `recaptcha` | `recaptcha_site_key` | `recaptcha_data` |
| `recaptcha-v3` | `recaptcha-v3` | `recaptcha_v3_site_key` | `recaptcha_v3_token` |

开关 `is_captcha` 来源于 Laravel `captcha_enable`，可为数值 0/1。
当验证码已开启而类型未知或 Site Key 缺失时，Gateway 返回 `enabled:true`
但 `type/siteKey` 保留 `null`；主题**必须阻止未经验证的登录**并显示配置错误。
任何 `secret_key`、`recaptcha_key` 或用户密码都不进入 bootstrap。
后端最终校验来源：`api/app/Services/CaptchaService.php`。

## 3. 非生产脱敏样例

正常登录上游：`{"status":"success","message":null,"data":{"auth_data":"Bearer EXAMPLEUSERSESSION","is_admin":false,"token":"legacy-value"}}`

Gateway 返回（示意）：`{"ok":true,"data":{"auth_data":"Bearer EXAMPLEUSERSESSION","is_admin":false},"meta":{"version":"1","requestId":"example"}}`

验证码开启访客配置（上游示意）：`{"status":"success","data":{"frontend_theme":"TXBoard","theme_config":{},"is_captcha":1,"captcha_type":"turnstile","turnstile_site_key":"public-key"}}`

Gateway `bootstrap.security.captcha`：`{"enabled":true,"type":"turnstile","siteKey":"public-key"}`。

以上内容不得作为真实 CI 集成通过或浏览器联调的证据。

## 4. 实施与验收空缺

- [x] 从当前 Laravel 源码核对路由和核心字段。
- [x] Gateway 限定公共验证码和登录响应字段，补齐契约测试。
- [x] 对套餐/用户/订单核心字段增加运行时校验，拒绝不规范 200 响应。
- [ ] 从**隔离真实运行环境**采集脱敏正常/失败 fixture（验证码失败、令牌过期、401/403/422/429、慢上游、非 JSON）。
- [ ] 依据真实样本冻结 OpenAPI 3.1 与 schema，明确所有状态码和 SDK 相互兼容。
- [ ] GitHub Actions 的真实 Laravel + MySQL/Redis E2E 及浏览器 Playwright。
- [ ] 登录（Turnstile / reCAPTCHA v2 / v3）、账户和订单的真实浏览器试运行。
- [ ] 可回滚的 opt-in 反代/部署整体验收。

> 安全原则：不要把真实密码、Bearer、验证码票据、站点敏感数据上传到 fixture 或 CI 日志。
