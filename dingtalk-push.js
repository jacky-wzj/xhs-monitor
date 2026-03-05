#!/usr/bin/env node
/**
 * 小红书舆情监控 — 钉钉推送
 *
 * 用法：node dingtalk-push.js [日期] [数据目录]
 * 例：  node dingtalk-push.js 2026-03-05 ../xiaohongshu
 *
 * 读取当天 JSON 数据，生成 Markdown 摘要，通过钉钉机器人 Webhook 推送
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ─── 配置 ─────────────────────────────────────
const DINGTALK_WEBHOOK =
  'https://oapi.dingtalk.com/robot/send?access_token=f3762153d0b1631cf323bd0010aec5d0ba4548e11917fd3c48e9a7637660713b';
const DINGTALK_SECRET =
  'SECd2d72abd2f03dca176a88f0f25a16b0477cbd0aeba1228f9d3cbb38a2054a26e';
const REPORT_BASE_URL = 'https://jacky-wzj.github.io/xhs-monitor/reports';

// ─── 参数 ─────────────────────────────────────
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const xhsDir = process.argv[3] || path.join(__dirname, '..', 'xiaohongshu');
const dataFile = path.join(xhsDir, `${date}.json`);

// ─── 读取数据 ──────────────────────────────────
if (!fs.existsSync(dataFile)) {
  console.error(`❌ 数据文件不存在: ${dataFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const notes = data.notes || [];

if (notes.length === 0) {
  console.log('ℹ️  无笔记数据，跳过推送');
  process.exit(0);
}

// ─── 统计 ─────────────────────────────────────
const totalLikes = notes.reduce((s, n) => s + (parseInt(n.likes) || 0), 0);
const totalComments = notes.reduce(
  (s, n) => s + (n.commentList || n.comments || []).length,
  0
);

// 按关键词分组
const groups = {};
for (const n of notes) {
  const kw = n.keyword || '未分类';
  if (!groups[kw]) groups[kw] = [];
  groups[kw].push(n);
}

// TOP5 热门
const top5 = [...notes]
  .sort((a, b) => (parseInt(b.likes) || 0) - (parseInt(a.likes) || 0))
  .slice(0, 5);

// ─── 构建 Markdown ─────────────────────────────
const reportUrl = `${REPORT_BASE_URL}/${date}.html`;

let md = `## 🔍 奇奇学 · 小红书舆情日报\n\n`;
md += `**${date}**\n\n`;
md += `---\n\n`;
md += `### 📊 今日概览\n\n`;
md += `| 指标 | 数值 |\n|:---|:---|\n`;
md += `| 监控笔记 | ${notes.length} 条 |\n`;
md += `| 总点赞 | ${totalLikes.toLocaleString()} |\n`;
md += `| 总评论 | ${totalComments} |\n`;
md += `| 关键词命中 | ${Object.keys(groups).length} 个 |\n\n`;

// 关键词分布
md += `### 🔎 关键词分布\n\n`;
for (const [kw, kwNotes] of Object.entries(groups)) {
  const kwLikes = kwNotes.reduce((s, n) => s + (parseInt(n.likes) || 0), 0);
  md += `- **${kw}**：${kwNotes.length} 条，共 ${kwLikes} 赞\n`;
}
md += `\n`;

// TOP5
md += `### 🏆 热门 TOP5\n\n`;
top5.forEach((n, i) => {
  const likes = parseInt(n.likes) || 0;
  const title = n.title && n.title.length > 30 ? n.title.slice(0, 30) + '...' : n.title;
  md += `${i + 1}. **${title}**  \n`;
  md += `   @${n.author} · ❤️${likes} · [查看原文](${n.url})\n\n`;
});

md += `---\n\n`;
md += `📄 [查看完整报告](${reportUrl})\n`;

// ─── 钉钉签名 ──────────────────────────────────
function generateSign() {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${DINGTALK_SECRET}`;
  const hmac = crypto
    .createHmac('sha256', DINGTALK_SECRET)
    .update(stringToSign)
    .digest('base64');
  const sign = encodeURIComponent(hmac);
  return { timestamp, sign };
}

// ─── 发送钉钉消息 ───────────────────────────────
function sendDingtalk(webhook, payload) {
  return new Promise((resolve, reject) => {
    const { timestamp, sign } = generateSign();
    const signedUrl = `${webhook}&timestamp=${timestamp}&sign=${sign}`;
    const body = JSON.stringify(payload);
    const url = new URL(signedUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errcode === 0) {
            resolve(json);
          } else {
            reject(new Error(`钉钉 API 错误: ${json.errcode} - ${json.errmsg}`));
          }
        } catch (e) {
          reject(new Error(`解析响应失败: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: `小红书舆情日报 ${date}`,
        text: md,
      },
    };

    const result = await sendDingtalk(DINGTALK_WEBHOOK, payload);
    console.log(`✅ 钉钉推送成功: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`❌ 钉钉推送失败: ${err.message}`);
    process.exit(1);
  }
})();
