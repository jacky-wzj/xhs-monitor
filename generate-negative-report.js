#!/usr/bin/env node
/**
 * 小红书舆情监控 — 差评报告生成器（AI 语义分析版）
 *
 * 用 LLM 判断帖子和评论的情感倾向，而非关键词匹配。
 * 通过 OpenAI-compatible API 批量分析。
 *
 * 用法：node generate-negative-report.js [日期] [数据目录]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const xhsDir = process.argv[3] || path.join(__dirname, '..', 'xiaohongshu');
const dataFile = path.join(xhsDir, `${date}.json`);
const outputDir = path.join(__dirname, 'reports');

fs.mkdirSync(outputDir, { recursive: true });

if (!fs.existsSync(dataFile)) {
  console.error(`❌ 数据文件不存在: ${dataFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const rawNotes = data.notes || [];

// 主体过滤：只保留标题或正文中包含"奇奇学"的笔记
const notes = rawNotes.filter(n => {
  const title = (n.title || '').toLowerCase();
  const content = (n.content || '').toLowerCase();
  const hasQiqixue = title.includes('奇奇学') || content.includes('奇奇学');
  if (!hasQiqixue) {
    console.log(`  🚫 过滤不相关笔记: ${(n.title || '无标题').substring(0, 40)}...`);
  }
  return hasQiqixue;
});

console.log(`📋 原始 ${rawNotes.length} 条，过滤后 ${notes.length} 条有效笔记（主体含"奇奇学"）`);

if (notes.length === 0) {
  console.log('ℹ️  无相关笔记数据，跳过分析');
  // 仍然生成空报告
}

// ─── AI API 配置 ─────────────────────────────────
// 使用 qwen（便宜快速）做情感分析
const API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const API_KEY = process.env.DASHSCOPE_API_KEY || (() => {
  // 从 openclaw.json 读取 qwen 配置
  try {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'));
    const providers = config?.models?.providers || {};
    for (const [key, val] of Object.entries(providers)) {
      if (key.includes('qwen') || (val.baseUrl && val.baseUrl.includes('dashscope'))) {
        return val.apiKey;
      }
    }
  } catch {}
  return '';
})();
const MODEL = 'qwen-turbo-latest';

// ─── API 调用 ─────────────────────────────────

function callLLM(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 4000,
    });

    const url = new URL(`${API_BASE}/chat/completions`);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`API error: ${json.error.message || JSON.stringify(json.error)}`));
          } else {
            resolve(json.choices?.[0]?.message?.content || '');
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── 批量情感分析 ─────────────────────────────────

async function analyzeSentiment(notes) {
  // 构建分析数据：每条帖子的标题、正文、评论
  const items = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const comments = note.commentList || note.comments || [];
    const commentTexts = comments
      .filter(c => c.content && c.content.trim())
      .map((c, ci) => `    评论${ci + 1} (@${c.author || '匿名'}): ${c.content.substring(0, 200)}`)
      .join('\n');

    items.push(
      `[帖子${i + 1}]\n` +
      `  标题: ${note.title || '无标题'}\n` +
      `  正文: ${(note.content || '').substring(0, 400)}\n` +
      (commentTexts ? `  评论:\n${commentTexts}` : '  评论: 无')
    );
  }

  // 分批处理（每批不超过 10 条，避免上下文过长）
  // 提取搜索关键词作为监控目标
  const targetKeywords = [...new Set(notes.map(n => n.keyword).filter(Boolean))];
  const targetDesc = targetKeywords.length > 0
    ? targetKeywords.join('、')
    : '奇奇学';

  const BATCH_SIZE = 10;
  const allResults = [];

  for (let batch = 0; batch < items.length; batch += BATCH_SIZE) {
    const batchItems = items.slice(batch, batch + BATCH_SIZE);
    const batchNotes = notes.slice(batch, batch + BATCH_SIZE);
    const batchStart = batch;

    const prompt = `你是一个产品舆情分析师，当前监控目标是"${targetDesc}"相关产品（一款儿童英语启蒙产品，含点读笔和牛津树分级阅读绘本）。

以下是从小红书抓取的帖子内容和评论。请逐条分析，判断帖子正文和每条评论是否对**监控目标（${targetDesc}）**的产品/服务表达了**明确的负面情绪**。

判定标准——只有以下情况才算"负面"：
✅ 对"${targetDesc}"产品明确表达不满、抱怨、吐槽（如"太坑了"、"后悔买了"、"质量差"）
✅ 描述"${targetDesc}"产品故障/缺陷（如"点不了"、"没声音"、"闪退"）
✅ 对"${targetDesc}"明确表达退货/退款意愿
✅ 直接贬低"${targetDesc}"产品

以下情况**不算负面**，请排除：
❌ 对其他品牌/竞品的负面评价（如吐槽小彼恩溢价、毛毛虫不好用等，这些不是对${targetDesc}的负面）
❌ 单纯提问/咨询（如"能不能点其他书？"）
❌ 潜在担忧/疑虑（如"不知道值不值"）
❌ 客观对比/中性讨论
❌ 口语化表达（如"差不多"、"爱的不行"）
❌ 正面体验、推荐、打卡

你必须严格按以下 JSON 格式输出，不要输出任何其他内容，不要用 markdown 代码块包裹。
noteIndex 必须使用本批次内的编号（从 1 开始），即帖子1 → noteIndex:1，帖子2 → noteIndex:2。
[
  {
    "noteIndex": <本批次内的帖子编号，帖子1=1，帖子2=2，以此类推>,
    "postSentiment": "positive 或 neutral 或 negative",
    "postReason": "简要说明判断理由（1句话）",
    "negativeComments": [
      {
        "commentIndex": <评论编号，评论1=1，评论2=2>,
        "reason": "简要说明为什么是负面（1句话）"
      }
    ]
  }
]

只输出有**明确负面内容**的帖子（postSentiment 为 negative 或有 negativeComments 不为空的）。
疑虑、提问、潜在担忧都不要输出。
如果所有帖子都是正面或中性，输出空数组 []。
不要输出 JSON 以外的任何文字。

以下是待分析的内容：

${batchItems.join('\n\n')}`;

    console.log(`  🤖 分析第 ${batchStart + 1}-${batchStart + batchItems.length} 条...`);

    try {
      const response = await callLLM([
        { role: 'system', content: '你是一个精准的产品舆情分析师。只输出 JSON，不输出其他内容。' },
        { role: 'user', content: prompt },
      ]);

      // 提取 JSON
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || response.match(/(\[[\s\S]*\])/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1] || jsonMatch[0];
      }

      let batchResults;
      try {
        batchResults = JSON.parse(jsonStr.trim());
      } catch (parseErr) {
        console.error(`  ⚠️  JSON 解析失败，尝试修复...`);
        // 尝试修复常见问题
        const fixedJson = jsonStr.trim().replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
        batchResults = JSON.parse(fixedJson);
      }

      if (!Array.isArray(batchResults)) {
        console.error(`  ⚠️  AI 返回非数组格式，跳过本批`);
        continue;
      }

      // 调整索引为全局索引（AI 返回的 noteIndex 是批次内的 1-based）
      for (const r of batchResults) {
        if (r.noteIndex != null) {
          // 判断 AI 返回的是批次内编号还是全局编号
          if (r.noteIndex <= batchItems.length) {
            // 批次内编号（期望行为）：加 batchStart 转全局
            r.noteIndex = r.noteIndex + batchStart;
          }
          // 否则 AI 已返回全局编号，直接使用
          allResults.push(r);
        }
      }
    } catch (err) {
      console.error(`  ⚠️  批次分析失败: ${err.message}`);
    }
  }

  return allResults;
}

// ─── HTML 生成 ─────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len = 500) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function renderNegativeItem(note, analysis, index) {
  const likes = parseInt(note.likes) || 0;
  const noteDate = note.date || '';
  const comments = note.commentList || note.comments || [];
  const negCommentIndices = new Set((analysis.negativeComments || []).map(c => c.commentIndex));

  // 帖子正文
  let postHtml = '';
  if (analysis.postSentiment === 'negative') {
    postHtml = `
      <div class="post-content negative-post">
        <div class="negative-badge">📝 帖子内容负面</div>
        <div class="ai-reason">🤖 ${escapeHtml(analysis.postReason)}</div>
        <p>${escapeHtml(truncate(note.content, 800))}</p>
      </div>`;
  } else if ((analysis.negativeComments || []).length > 0 && note.content) {
    postHtml = `
      <div class="post-content">
        <div class="context-badge">📄 帖子原文</div>
        <p>${escapeHtml(truncate(note.content, 500))}</p>
      </div>`;
  }

  // 差评评论 + 全部评论上下文
  let commentsHtml = '';
  const negComments = (analysis.negativeComments || []);
  const negCommentIndexSet = new Set(negComments.map(nc => nc.commentIndex));
  const negReasonMap = {};
  for (const nc of negComments) negReasonMap[nc.commentIndex] = nc.reason;

  if (comments.length > 0) {
    const negCount = negComments.length;
    commentsHtml = `
      <div class="negative-comments">
        <div class="negative-badge">💬 评论区 (${comments.length} 条${negCount > 0 ? `，${negCount} 条负面` : ''})</div>
        ${comments.map((c, ci) => {
          const idx = ci + 1;
          const isNeg = negCommentIndexSet.has(idx);
          return `
            <div class="${isNeg ? 'neg-comment' : 'normal-comment'}">
              <div class="neg-comment-header">
                <span class="comment-author">@${escapeHtml(c.author)}</span>
                ${c.time ? `<span class="comment-time">${escapeHtml(c.time)}</span>` : ''}
                ${c.likes && c.likes !== '0' ? `<span class="comment-likes">👍${c.likes}</span>` : ''}
                ${isNeg ? '<span class="neg-label">⚠️ 负面</span>' : ''}
              </div>
              <div class="comment-body">${escapeHtml(truncate(c.content, 300))}</div>
              ${isNeg && negReasonMap[idx] ? `<div class="ai-reason">🤖 ${escapeHtml(negReasonMap[idx])}</div>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }

  return `
    <div class="neg-card">
      <div class="neg-header">
        <div class="neg-title">
          <span class="neg-index">#${index}</span>
          <h3>${escapeHtml(note.title || '无标题')}</h3>
        </div>
        <div class="neg-meta">
          <span class="author">👤 ${escapeHtml(note.author)}</span>
          <span class="likes">❤️ ${likes}</span>
          ${noteDate ? `<span class="date">📅 ${escapeHtml(noteDate)}</span>` : ''}
          <span class="keyword-tag">${escapeHtml(note.keyword)}</span>
          <a href="${escapeHtml(note.url)}" target="_blank" rel="noopener">🔗 原文</a>
        </div>
      </div>
      ${postHtml}
      ${commentsHtml}
    </div>`;
}

function generateHtml(notes, negativeResults) {
  const negPostCount = negativeResults.filter(r => r.analysis.postSentiment === 'negative').length;
  const negCommentCount = negativeResults.filter(r => (r.analysis.negativeComments || []).length > 0).length;

  const noDataHtml = negativeResults.length === 0
    ? `<div class="no-data">
        <div class="no-data-icon">🎉</div>
        <h2>今日无差评内容</h2>
        <p>AI 分析了 ${notes.length} 条笔记，未发现针对奇奇学的负面评价。</p>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>奇奇学 差评监控 — ${date}</title>
  <style>
    :root {
      --bg: #0f0f0f;
      --card-bg: #1a1a1a;
      --card-border: #2a2a2a;
      --text: #e0e0e0;
      --text-dim: #888;
      --accent: #ff6b35;
      --red: #ff4757;
      --red-bg: rgba(255, 71, 87, 0.08);
      --red-border: rgba(255, 71, 87, 0.25);
      --green: #2ed573;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 20px;
      max-width: 900px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      padding: 30px 0;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 30px;
    }
    .header h1 { font-size: 1.8em; color: var(--red); margin-bottom: 8px; }
    .header .date { color: var(--text-dim); font-size: 1.1em; }
    .header .stats {
      margin-top: 12px;
      font-size: 0.95em;
      color: var(--text-dim);
    }
    .header .stats strong { color: var(--red); }
    .header .method {
      margin-top: 6px;
      font-size: 0.8em;
      color: var(--text-dim);
      opacity: 0.7;
    }
    .neg-card {
      background: var(--card-bg);
      border: 1px solid var(--red-border);
      border-radius: 12px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .neg-header { padding: 16px; border-bottom: 1px solid var(--card-border); }
    .neg-title { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
    .neg-index {
      background: var(--red);
      color: white;
      font-size: 0.8em;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .neg-title h3 { font-size: 1.1em; }
    .neg-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85em; align-items: center; }
    .neg-meta .author { color: var(--accent); }
    .neg-meta .likes { color: var(--red); }
    .neg-meta .date { color: var(--text-dim); }
    .neg-meta a { color: var(--accent); text-decoration: none; font-size: 0.85em; }
    .neg-meta a:hover { text-decoration: underline; }
    .keyword-tag {
      background: rgba(255, 107, 53, 0.15);
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8em;
    }
    .post-content { padding: 16px; }
    .negative-post { background: var(--red-bg); }
    .negative-badge {
      font-size: 0.85em;
      font-weight: 600;
      color: var(--red);
      margin-bottom: 8px;
    }
    .context-badge {
      font-size: 0.85em;
      font-weight: 600;
      color: var(--text-dim);
      margin-bottom: 8px;
    }
    .ai-reason {
      font-size: 0.85em;
      color: var(--accent);
      margin: 6px 0;
      padding: 4px 8px;
      background: rgba(255, 107, 53, 0.08);
      border-radius: 4px;
      border-left: 3px solid var(--accent);
    }
    .post-content p { color: var(--text-dim); font-size: 0.9em; line-height: 1.7; }
    .negative-comments { padding: 16px; border-top: 1px solid var(--card-border); }
    .neg-comment {
      background: var(--red-bg);
      border: 1px solid var(--red-border);
      border-radius: 8px;
      padding: 12px;
      margin-top: 10px;
    }
    .normal-comment {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px;
      margin-top: 10px;
    }
    .neg-label {
      color: var(--red);
      font-size: 0.8em;
      font-weight: 600;
    }
    .neg-comment-header {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 6px;
      font-size: 0.85em;
    }
    .comment-author { color: var(--accent); font-weight: 500; }
    .comment-time { color: var(--text-dim); }
    .comment-likes { color: var(--text-dim); }
    .comment-body { font-size: 0.9em; color: var(--text); line-height: 1.6; }
    .no-data {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-dim);
    }
    .no-data-icon { font-size: 3em; margin-bottom: 16px; }
    .no-data h2 { color: var(--green); margin-bottom: 8px; }
    .footer {
      text-align: center;
      padding: 30px 0;
      color: var(--text-dim);
      font-size: 0.8em;
      border-top: 1px solid var(--card-border);
      margin-top: 30px;
    }
    @media (max-width: 600px) {
      body { padding: 10px; }
      .header h1 { font-size: 1.4em; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚠️ 奇奇学 · 差评监控</h1>
    <div class="date">${date}</div>
    <div class="stats">
      共监控 <strong>${notes.length}</strong> 条笔记，发现 <strong>${negativeResults.length}</strong> 条含负面内容
      （差评帖 ${negPostCount} · 含负面评论 ${negCommentCount}）
    </div>
    <div class="method">分析方式：AI 语义分析（${MODEL}）</div>
  </div>

  ${noDataHtml}
  ${negativeResults.map((item, i) => renderNegativeItem(item.note, item.analysis, i + 1)).join('')}

  <div class="footer">
    <p>Generated by xhs-monitor (AI sentiment) · ${new Date().toISOString()}</p>
    <p>分析模型: ${MODEL} · 数据来源：小红书</p>
  </div>
</body>
</html>`;
}

// ─── 主流程 ─────────────────────────────────

(async () => {
  if (!API_KEY) {
    console.error('❌ 未找到 API Key，请设置 DASHSCOPE_API_KEY 环境变量或在 openclaw.json 配置 qwen provider');
    process.exit(1);
  }

  console.log(`📊 开始 AI 情感分析: ${notes.length} 条笔记`);

  const analysisResults = await analyzeSentiment(notes);
  console.log(`  📋 AI 识别出 ${analysisResults.length} 条含负面内容`);

  // 匹配回笔记数据
  const negativeResults = [];
  for (const analysis of analysisResults) {
    const noteIdx = analysis.noteIndex - 1;  // AI 输出从 1 开始
    if (noteIdx >= 0 && noteIdx < notes.length) {
      negativeResults.push({ note: notes[noteIdx], analysis });
    }
  }

  console.log(`📊 总笔记: ${notes.length}, 含负面内容: ${negativeResults.length}`);
  console.log(`  - 差评帖子: ${negativeResults.filter(r => r.analysis.postSentiment === 'negative').length}`);
  console.log(`  - 含负面评论: ${negativeResults.filter(r => (r.analysis.negativeComments || []).length > 0).length}`);

  // 生成 HTML
  const html = generateHtml(notes, negativeResults);
  const outputFile = path.join(outputDir, `${date}-negative.html`);
  fs.writeFileSync(outputFile, html, 'utf8');
  console.log(`✅ 差评报告已生成: ${outputFile}`);
})();
