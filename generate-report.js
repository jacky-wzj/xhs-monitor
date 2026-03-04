#!/usr/bin/env node
/**
 * 小红书舆情监控 HTML 报告生成器
 * 
 * 用法：node generate-report.js [日期] [数据目录]
 * 例：node generate-report.js 2026-03-05 ../xiaohongshu
 */

const fs = require('fs');
const path = require('path');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const xhsDir = process.argv[3] || path.join(__dirname, '..', 'xiaohongshu');
const dataFile = path.join(xhsDir, `${date}.json`);
const screenshotDir = path.join(xhsDir, 'screenshots', date);
const outputDir = path.join(__dirname, 'reports');
const screenshotOutputDir = path.join(__dirname, 'screenshots', date);

// 确保输出目录存在
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(screenshotOutputDir, { recursive: true });

// 读取数据
if (!fs.existsSync(dataFile)) {
  console.error(`❌ 数据文件不存在: ${dataFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const notes = data.notes || [];

console.log(`📊 读取 ${notes.length} 条笔记`);

// 复制截图到输出目录
let screenshotCount = 0;
for (const note of notes) {
  if (note.screenshot && fs.existsSync(note.screenshot)) {
    const filename = path.basename(note.screenshot);
    const dest = path.join(screenshotOutputDir, filename);
    fs.copyFileSync(note.screenshot, dest);
    // 更新截图路径为相对路径
    note._screenshotRel = `../screenshots/${date}/${filename}`;
    screenshotCount++;
  }
}
console.log(`📸 复制 ${screenshotCount} 张截图`);

// 按关键词分组
const groups = {};
const keywordOrder = ['奇奇学', '奇奇学点读笔', '奇奇学牛津树'];
for (const note of notes) {
  const kw = note.keyword || '未分类';
  if (!groups[kw]) groups[kw] = [];
  groups[kw].push(note);
}

// 统计
const totalLikes = notes.reduce((sum, n) => sum + (parseInt(n.likes) || 0), 0);
const totalComments = notes.reduce((sum, n) => sum + (n.commentList || n.comments || []).length, 0);
const topNotes = [...notes].sort((a, b) => (parseInt(b.likes) || 0) - (parseInt(a.likes) || 0)).slice(0, 5);
const authors = {};
notes.forEach(n => { authors[n.author] = (authors[n.author] || 0) + 1; });
const topAuthors = Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 5);

// 生成 HTML
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len = 200) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function renderNote(note, index) {
  const likes = parseInt(note.likes) || 0;
  const comments = note.commentList || note.comments || [];
  const commentTotal = note.commentTotal || comments.length;
  const screenshotHtml = note._screenshotRel
    ? `<div class="screenshot"><img src="${escapeHtml(note._screenshotRel)}" alt="截图" loading="lazy" onclick="this.classList.toggle('expanded')"></div>`
    : '';

  const commentsHtml = comments.length > 0
    ? `<div class="comments">
        <div class="comments-header">💬 评论 (${commentTotal})</div>
        ${comments.slice(0, 10).map(c => `
          <div class="comment">
            <span class="comment-author">${escapeHtml(c.author)}</span>
            <span class="comment-content">${escapeHtml(truncate(c.content, 150))}</span>
            ${c.likes ? `<span class="comment-likes">👍${c.likes}</span>` : ''}
          </div>
        `).join('')}
        ${comments.length > 10 ? `<div class="more-comments">还有 ${comments.length - 10} 条评论...</div>` : ''}
      </div>`
    : '';

  return `
    <div class="note-card">
      <div class="note-header">
        <h3>${index}. ${escapeHtml(note.title)}</h3>
        <div class="note-meta">
          <span class="author">👤 ${escapeHtml(note.author)}</span>
          <span class="likes">❤️ ${likes}</span>
          <span class="keyword-tag">${escapeHtml(note.keyword)}</span>
        </div>
      </div>
      ${screenshotHtml}
      <div class="note-content">
        <p>${escapeHtml(truncate(note.content, 500))}</p>
      </div>
      <div class="note-footer">
        <a href="${escapeHtml(note.url)}" target="_blank" rel="noopener">🔗 查看原文</a>
      </div>
      ${commentsHtml}
    </div>
  `;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>奇奇学 小红书舆情监控 — ${date}</title>
  <style>
    :root {
      --bg: #0f0f0f;
      --card-bg: #1a1a1a;
      --card-border: #2a2a2a;
      --text: #e0e0e0;
      --text-dim: #888;
      --accent: #ff6b35;
      --accent2: #4ecdc4;
      --red: #ff4757;
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
    .header h1 {
      font-size: 1.8em;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .header .date { color: var(--text-dim); font-size: 1.1em; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 30px;
    }
    .summary-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
    }
    .summary-card .number {
      font-size: 2em;
      font-weight: 700;
      color: var(--accent);
    }
    .summary-card .label { color: var(--text-dim); font-size: 0.9em; }
    .section-title {
      font-size: 1.4em;
      color: var(--accent2);
      margin: 30px 0 15px;
      padding-bottom: 8px;
      border-bottom: 2px solid var(--accent2);
    }
    .note-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      margin-bottom: 16px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .note-card:hover { border-color: var(--accent); }
    .note-header { padding: 16px 16px 8px; }
    .note-header h3 { font-size: 1.1em; margin-bottom: 8px; }
    .note-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85em; }
    .note-meta .author { color: var(--accent2); }
    .note-meta .likes { color: var(--red); }
    .keyword-tag {
      background: rgba(255, 107, 53, 0.15);
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8em;
    }
    .screenshot { padding: 8px 16px; }
    .screenshot img {
      width: 100%;
      max-height: 400px;
      object-fit: contain;
      border-radius: 8px;
      cursor: pointer;
      transition: max-height 0.3s;
    }
    .screenshot img.expanded { max-height: none; }
    .note-content { padding: 8px 16px; }
    .note-content p { color: var(--text-dim); font-size: 0.9em; }
    .note-footer { padding: 8px 16px 12px; }
    .note-footer a {
      color: var(--accent);
      text-decoration: none;
      font-size: 0.85em;
    }
    .note-footer a:hover { text-decoration: underline; }
    .comments {
      border-top: 1px solid var(--card-border);
      padding: 12px 16px;
    }
    .comments-header {
      font-size: 0.9em;
      color: var(--accent2);
      margin-bottom: 8px;
    }
    .comment {
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.85em;
    }
    .comment-author { color: var(--accent); margin-right: 8px; }
    .comment-content { color: var(--text-dim); }
    .comment-likes { color: var(--text-dim); font-size: 0.8em; margin-left: 6px; }
    .more-comments { color: var(--text-dim); font-size: 0.8em; padding-top: 6px; }
    .top-notes { margin-bottom: 30px; }
    .top-note-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: var(--card-bg);
      border-radius: 8px;
      margin-bottom: 6px;
    }
    .top-note-item .rank {
      font-size: 1.2em;
      font-weight: 700;
      color: var(--accent);
      min-width: 30px;
    }
    .top-note-item .info { flex: 1; margin: 0 12px; }
    .top-note-item .info .title { font-size: 0.9em; }
    .top-note-item .info .author { font-size: 0.8em; color: var(--text-dim); }
    .top-note-item .likes-count { color: var(--red); font-weight: 600; }
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
      .summary { grid-template-columns: repeat(2, 1fr); }
      .header h1 { font-size: 1.4em; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔍 奇奇学 · 小红书舆情监控</h1>
    <div class="date">${date}</div>
  </div>

  <div class="summary">
    <div class="summary-card">
      <div class="number">${notes.length}</div>
      <div class="label">监控笔记</div>
    </div>
    <div class="summary-card">
      <div class="number">${totalLikes.toLocaleString()}</div>
      <div class="label">总点赞</div>
    </div>
    <div class="summary-card">
      <div class="number">${totalComments}</div>
      <div class="label">总评论</div>
    </div>
    <div class="summary-card">
      <div class="number">${keywordOrder.filter(k => groups[k]?.length).length}</div>
      <div class="label">关键词命中</div>
    </div>
  </div>

  <h2 class="section-title">🏆 热门 TOP5</h2>
  <div class="top-notes">
    ${topNotes.map((n, i) => `
      <div class="top-note-item">
        <span class="rank">#${i + 1}</span>
        <div class="info">
          <div class="title">${escapeHtml(truncate(n.title, 40))}</div>
          <div class="author">@${escapeHtml(n.author)} · ${escapeHtml(n.keyword)}</div>
        </div>
        <span class="likes-count">❤️ ${parseInt(n.likes) || 0}</span>
      </div>
    `).join('')}
  </div>

  ${keywordOrder.map(kw => {
    const kwNotes = groups[kw] || [];
    if (!kwNotes.length) return '';
    let idx = 0;
    // 计算全局起始编号
    let globalStart = 1;
    for (const k of keywordOrder) {
      if (k === kw) break;
      globalStart += (groups[k] || []).length;
    }
    return `
      <h2 class="section-title">🔎 ${escapeHtml(kw)} (${kwNotes.length})</h2>
      ${kwNotes.map((n, i) => renderNote(n, globalStart + i)).join('')}
    `;
  }).join('')}

  <div class="footer">
    <p>Generated by xhs-monitor · ${new Date().toISOString()}</p>
    <p>数据来源：小红书 · 过滤了品牌官方号</p>
  </div>
</body>
</html>`;

const outputFile = path.join(outputDir, `${date}.html`);
fs.writeFileSync(outputFile, html, 'utf8');
console.log(`✅ 报告已生成: ${outputFile}`);
console.log(`📊 笔记: ${notes.length}, 截图: ${screenshotCount}, 总赞: ${totalLikes}`);

// 同时复制 JSON 数据
const dataOutputDir = path.join(__dirname, 'data');
fs.mkdirSync(dataOutputDir, { recursive: true });
fs.copyFileSync(dataFile, path.join(dataOutputDir, `${date}.json`));
console.log(`📁 数据已复制到 data/${date}.json`);
