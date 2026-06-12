# 内部培训资料库 MVP

一个可部署到 Netlify 的内部培训资料库，包含账号登录、管理员/员工权限、资料管理、图文/视频/思维导图、账号管理和操作日志。

生产环境使用 Netlify Functions 提供 API，并使用 Netlify Blobs 持久化数据。Deploy Preview 使用独立的 Deploy Blobs，不会污染生产数据。

## 功能

- 管理员可以创建、编辑、停用、删除账号，并且系统会阻止删除当前登录账号或最后一个启用管理员。
- 资料支持文字、图文、视频和导图内容。
- 新导图模块支持添加子节点、添加同级节点、拖拽调整层级、折叠/展开、批量移动、复制、剪切、粘贴。
- 导图结构支持思维导图、组织结构图、鱼骨图、逻辑图、时间轴、树状图和流程图。

## 本地运行

安装依赖：

```powershell
npm install
```

使用本地 Node.js 服务：

```powershell
npm start
```

打开 `http://localhost:3000`。

本地默认账号：

- 管理员：`admin` / `admin123`
- 普通员工：`employee` / `employee123`

也可以使用 Netlify 本地环境运行 Functions 和 Blobs：

```powershell
npm run dev
```

如需固定本地 Netlify Function 会话密钥，可在 `.env` 中设置：

```text
SESSION_SECRET=至少32位的随机字符串
```

`.env` 已被 Git 忽略，请勿提交任何密钥。

## Netlify 部署

项目已经包含：

- `netlify.toml`：构建、静态资源、安全响应头和 SPA 路由配置
- `netlify/functions/api.mjs`：Netlify Functions API
- `@netlify/blobs`：生产数据持久化
- `.github/workflows/ci.yml`：GitHub Push 和 Pull Request 构建检查

在 Netlify 中导入 GitHub 仓库后，平台会自动读取配置：

```text
Build command: npm run build
Publish directory: public
Functions directory: netlify/functions
Node version: 20
```

生产环境首次打开站点时会进入初始化页面，由首位访问者创建管理员密码。初始化完成后入口会自动关闭。

建议在 Netlify 项目的环境变量中设置：

```text
SESSION_SECRET=至少32位的随机字符串
```

可选设置：

```text
INITIAL_ADMIN_PASSWORD=至少12位的首次管理员密码
INITIAL_EMPLOYEE_PASSWORD=至少12位的首次员工密码
```

如果没有设置 `SESSION_SECRET`，应用会从数据库中的管理员密码哈希派生会话密钥；修改管理员密码后旧会话会自动失效。如果生产环境没有设置 `INITIAL_EMPLOYEE_PASSWORD`，初始员工账号会保持停用。

初始密码变量只在 Blobs 中还没有数据库时生效；初始化后请在管理后台重置密码。

## GitHub 持续部署

1. 将该目录推送到 GitHub 仓库的 `main` 分支。
2. 在 Netlify 选择 `Add new project`，导入该 GitHub 仓库。
3. 添加上述环境变量并触发部署。
4. 后续推送到 `main` 会自动发布生产版本，Pull Request 会生成 Deploy Preview。

## 验证

```powershell
npm run check
npm run build
npx netlify build
```

在线版单张图片限制为 3MB，上传视频限制为 4MB；更大的视频建议使用外链 URL。

## Cloudflare 部署

仓库仍保留 Cloudflare Pages Functions 版本：

- 静态网页目录：`public`
- Cloudflare API：`functions/api/[[path]].js`
- Cloudflare 配置：`wrangler.toml`
