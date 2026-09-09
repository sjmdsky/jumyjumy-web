// @ts-check
import { defineConfig, envField } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'

// 数据来自后端 JSON API：/q/<query> -> <API_BASE_URL>/q/<query>
//
// 为什么必须 SSR 而不是静态构建：
//   1. 只有服务端能发真实状态码——slug 变化要 301（外链权重不丢）、
//      问题不存在要 404（避免 soft 404 拖累抓取预算）。
//   2. 用户提问随时产出新页面，静态构建会把页面集合冻结在 build 那一刻。
//
// 运行时是 Cloudflare Workers。构建产物一分为二，由 wrangler.jsonc 绑定：
//   dist/_worker.js/index.js  —— SSR 入口（main）
//   dist/ 其余文件            —— 静态资源（assets），首页 prerender 后落在这里
// 请求先匹配静态资源，未命中才进 Worker，所以首页不花 Worker 调用。
// 代价是 src/ 里不能出现 Node 专有 API，只能用 Workers 也有的 Web 标准 API。
export default defineConfig({
  site: 'https://www.jumyjumy.com',
  output: 'server',
  adapter: cloudflare(),
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  env: {
    schema: {
      // context: 'server' —— 后端地址只在服务端取数时使用，不下发到浏览器。
      // access: 'secret' —— 关键：'public' 的服务端变量会在构建期被内联进产物，
      // 改地址就得重新构建。'secret' 才是运行时从 process.env 读取，
      // 部署时换环境只需改环境变量。
      // 在 Workers 上，适配器会在请求进入时把 wrangler 的 vars / secret
      // 拷进 process.env，所以这里读到的就是 wrangler.jsonc 里那一份。
      API_BASE_URL: envField.string({
        context: 'server',
        access: 'secret',
        default: 'http://localhost:3000',
      }),
      // 转发访客 IP 时随行的共享密钥，与后端的
      // APP__RATE_LIMIT__TRUSTED_CLIENT_IP_TOKEN 同值。
      //
      // optional 而不给 default：这是密钥，任何默认值都等于一把人人可见的
      // 钥匙。缺失时前端不发 IP 头，后端回落到 cf-connecting-ip，也就是这
      // 套机制存在之前的行为——两边可以先后上线，中间态是安全的。
      GATEWAY_TOKEN: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
      }),
    },
  },
})
