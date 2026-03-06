#!/usr/bin/env node
/**
 * 小红书舆情监控 — 差评报告生成器
 *
 * 筛选逻辑：
 * 1. 笔记正文包含负面关键词 → 整条笔记展示
 * 2. 笔记评论包含负面关键词 → 展示笔记标题 + 差评评论
 *
 * 用法：node generate-negative-report.js [日期] [数据目录]
 */

const fs = require('fs');
const path = require('path');

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
const notes = data.notes || [];

// ─── 负面关键词（精确短语，避免单字误判）─────────────
// 分为"强负面"和"弱负面"
// 强负面：直接命中
// 弱负面：需要排除误判模式后才算命中
const STRONG_NEGATIVE = [
  // 产品差评
  '垃圾', '坑爹', '骗子', '骗人', '忽悠', '割韭菜', '智商税',
  '不好用', '不值', '不推荐', '不建议', '不靠谱',
  '难用', '太差', '太烂', '很差', '好差', '超差', '质量差',
  // 退换/售后
  '退款', '退货', '退钱', '投诉', '维权', '售后差', '客服差',
  // 功能问题
  '闪退', '卡顿', '死机', '崩溃', '打不开', '用不了', '不能用',
  '没反应', '没声音', '不识别', '识别不了', '点不了', '无法使用',
  // 内容质量
  '翻译差', '翻译错', '发音不准', '发音错', '内容少', '内容差',
  '粗糙', '敷衍', '不准确', '错误多', '错别字',
  // 价格（精确短语）
  '太贵了', '好贵', '涨价', '变相收费', '隐性收费',
  '性价比低', '不值这个价',
  // 情感负面
  '后悔', '上当', '踩雷', '避雷', '拔草',
  '恶心', '坑钱', '吃灰',
];

// 弱负面：容易误判的词，需要排除常见无害用法
const WEAK_NEGATIVE = [
  { keyword: '差', excludePatterns: ['差不多', '差一点', '没差', '相差', '差别', '时差', '出差', '差异', '温差', '落差'] },
  { keyword: '不好', excludePatterns: ['不好意思', '不好说', '好与不好', '好不好', '不好吗'] },
  { keyword: '不行', excludePatterns: ['的不行', '得不行', '不行了吧'] },  // "爱的不行" = 很喜欢
  { keyword: '失望', excludePatterns: ['不失望', '没失望'] },
  { keyword: '吐槽', excludePatterns: [] },  // 吐槽有时是轻松语境，但保留
  { keyword: '无语', excludePatterns: [] },
  { keyword: '不如', excludePatterns: ['不如早点', '不如买', '不如直接', '不如说'] },  // "还不如早点买" = 推荐购买
  { keyword: '浪费', excludePatterns: ['不浪费', '没浪费'] },
  { keyword: '太贵', excludePatterns: [] },
  { keyword: '收费', excludePatterns: ['免费', '不收费'] },
  { keyword: '续费', excludePatterns: ['免续费'] },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchNegativeKeywords(text) {
  if (!text) return [];
  const matches = [];

  // 强负面：直接匹配
  for (const kw of STRONG_NEGATIVE) {
    if (text.includes(kw)) {
      matches.push(kw);
    }
  }

  // 弱负面：排除误判后匹配
  for (const { keyword, excludePatterns } of WEAK_NEGATIVE) {
    if (!text.includes(keyword)) continue;

    // 检查是否被排除模式覆盖
    let excluded = false;
    for (const pattern of excludePatterns) {
      if (text.includes(pattern)) {
        excluded = true;
        break;
      }
    }
    if (!excluded) {
      matches.push(keyword);
    }
  }

  return [...new Set(matches)];
}

// ─── 筛选差评内容 ─────────────────────────────────
const negativeResults = [];

for (const note of notes) {
  const contentText = (note.content || '') + ' ' + (note.title || '');
  const contentMatches = matchNegativeKeywords(contentText);
  const comments = note.commentList || note.comments || [];

  const negativeComments = [];
  for (const c of comments) {
    const commentText = c.content || '';
    const commentMatches = matchNegativeKeywords(commentText);
    if (commentMatches.length > 0) {
      negativeComments.push({ ...c, _matchedKeywords: commentMatches });
    }
  }

  if (contentMatches.length > 0 || negativeComments.length > 0) {
    negativeResults.push({
      note,
      contentMatches,
      negativeComments,
      isNegativePost: contentMatches.length > 0,
    });
  }
}

console.log(`📊 总笔记: ${notes.length}, 含负面内容: ${negativeResults.length}`);
console.log(`  - 差评帖子: ${negativeResults.filter(r => r.isNegativePost).length}`);
console.log(`  - 含差评评论: ${negativeResults.filter(r => r.negativeComments.length > 0).length}`);

// ─── HTML 生成 ─────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightKeywords(text, keywords) {
  if (!text || !keywords.length) return escapeHtml(text);
  let result = escapeHtml(text);
  for (const kw of keywords) {
    const escaped = escapeHtml(kw);
    result = result.replace(new RegExp(escapeRegex(escaped), 'g'), `<mark>${escaped}</mark>`);
  }
  return result;
}

function truncate(str, len = 500) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function renderNegativeItem(item, index) {
  const { note, contentMatches, negativeComments, isNegativePost } = item;
  const likes = parseInt(note.likes) || 0;
  const noteDate = note.date || '';

  // 帖子正文部分（负面帖子高亮展示，仅评论负面时也展示原文作为上下文）
  let postHtml = '';
  if (isNegativePost) {
    postHtml = `
      <div class="post-content negative-post">
        <div class="negative-badge">📝 帖子内容含负面</div>
        <div class="matched-keywords">关键词: ${contentMatches.map(k => `<span class="kw-tag">${escapeHtml(k)}</span>`).join(' ')}</div>
        <p>${highlightKeywords(truncate(note.content, 800), contentMatches)}</p>
      </div>`;
  } else if (negativeComments.length > 0 && note.content) {
    postHtml = `
      <div class="post-content">
        <div class="context-badge">📄 帖子原文</div>
        <p>${escapeHtml(truncate(note.content, 500))}</p>
      </div>`;
  }

  // 差评评论部分
  let commentsHtml = '';
  if (negativeComments.length > 0) {
    commentsHtml = `
      <div class="negative-comments">
        <div class="negative-badge">💬 差评评论 (${negativeComments.length})</div>
        ${negativeComments.map(c => `
          <div class="neg-comment">
            <div class="neg-comment-header">
              <span class="comment-author">@${escapeHtml(c.author)}</span>
              ${c.time ? `<span class="comment-time">${escapeHtml(c.time)}</span>` : ''}
              ${c.likes && c.likes !== '0' ? `<span class="comment-likes">👍${c.likes}</span>` : ''}
            </div>
            <div class="comment-body">
              ${highlightKeywords(truncate(c.content, 300), c._matchedKeywords)}
            </div>
            <div class="matched-keywords">命中: ${c._matchedKeywords.map(k => `<span class="kw-tag">${escapeHtml(k)}</span>`).join(' ')}</div>
          </div>
        `).join('')}
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

const noDataHtml = negativeResults.length === 0
  ? `<div class="no-data">
      <div class="no-data-icon">🎉</div>
      <h2>今日无差评内容</h2>
      <p>共监控 ${notes.length} 条笔记，未发现负面关键词。</p>
    </div>`
  : '';

const html = `<!DOCTYPE html>
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
      --yellow: #ffa502;
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
    .matched-keywords { margin: 6px 0; }
    .kw-tag {
      display: inline-block;
      background: rgba(255, 71, 87, 0.15);
      color: var(--red);
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8em;
      margin: 2px 3px 2px 0;
    }
    .post-content p { color: var(--text-dim); font-size: 0.9em; line-height: 1.7; }
    mark {
      background: rgba(255, 71, 87, 0.3);
      color: var(--red);
      padding: 0 2px;
      border-radius: 2px;
    }
    .negative-comments { padding: 16px; border-top: 1px solid var(--card-border); }
    .neg-comment {
      background: var(--red-bg);
      border: 1px solid var(--red-border);
      border-radius: 8px;
      padding: 12px;
      margin-top: 10px;
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
      （差评帖 ${negativeResults.filter(r => r.isNegativePost).length} · 差评评论 ${negativeResults.filter(r => r.negativeComments.length > 0).length}）
    </div>
  </div>

  ${noDataHtml}
  ${negativeResults.map((item, i) => renderNegativeItem(item, i + 1)).join('')}

  <div class="footer">
    <p>Generated by xhs-monitor (negative) · ${new Date().toISOString()}</p>
    <p>关键词库: ${STRONG_NEGATIVE.length + WEAK_NEGATIVE.length} 个（强 ${STRONG_NEGATIVE.length} + 弱 ${WEAK_NEGATIVE.length}） · 数据来源：小红书</p>
  </div>
</body>
</html>`;

const outputFile = path.join(outputDir, `${date}-negative.html`);
fs.writeFileSync(outputFile, html, 'utf8');
console.log(`✅ 差评报告已生成: ${outputFile}`);
