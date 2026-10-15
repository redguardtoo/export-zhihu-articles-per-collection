// ==UserScript==
// @name         知乎收藏夹导出 Markdown
// @namespace    https://www.zhihu.com/
// @version      2.0.3
// @description  点击右上"导出本收藏夹"按钮, 展开收藏夹文章全文，逐页导出 Markdown
// @match        https://www.zhihu.com/collection/*
// @grant        none
// @author      Chen Bin
// @license     MIT
// @run-at      document-end
// ==/UserScript==

(async function () {
  'use strict';

  function createExportButton() {
    if (document.querySelector('#zhihu-export-collection')) {
      return;
    }

    const button = document.createElement('button');
    button.id = 'zhihu-export-collection';
    button.textContent = '导出本收藏夹';

    Object.assign(button.style, {
      position: 'fixed',
      top: '100px',
      right: '24px',
      zIndex: '999999',
      padding: '10px 16px',
      color: '#fff',
      background: '#1677ff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '14px'
    });

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '正在导出…';

      try {
        await startExport();
      } finally {
        button.disabled = false;
        button.textContent = '导出本收藏夹';
      }
    });

    document.body.appendChild(button);
  }

  async function startExport() {
    // ===== 可调整的参数 =====
    const EXPAND_DELAY = 1500;
    const PAGE_DELAY = 4000;
    const ARTICLE_DELAY = 2000;

    const sleep = ms =>
          new Promise(resolve => setTimeout(resolve, ms));

    const articles = new Map();
    let stopped = false;

    // 避免重复启动
    if (window.__zhihuCollectionExportRunning) {
      alert('导出任务已经在运行。');
      return;
    }
    window.__zhihuCollectionExportRunning = true;

    // ===== HTML 转 Markdown =====

    function inlineMarkdown(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue || '';
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
      }

      const tag = node.tagName.toLowerCase();

      if (['script', 'style', 'svg', 'button'].includes(tag)) {
        return '';
      }

      const content = () =>
            [...node.childNodes].map(inlineMarkdown).join('');

      if (tag === 'br') return '\n';

      if (tag === 'strong' || tag === 'b') {
        return `**${content()}**`;
      }

      if (tag === 'em' || tag === 'i') {
        return `*${content()}*`;
      }

      if (tag === 'code') {
        return `\`${content()}\``;
      }

      if (tag === 'a') {
        const text = content().trim();
        const href = node.href;

        if (!text) return '';
        if (!href || href.startsWith('javascript:')) {
          return text;
        }

        return `[${text}](${href})`;
      }

      if (tag === 'img') {
        // 按需求忽略图片
        return '';
      }

      return content();
    }

    function blockMarkdown(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return inlineMarkdown(node);
      }

      const tag = node.tagName.toLowerCase();

      if (['script', 'style', 'svg', 'button'].includes(tag)) {
        return '';
      }

      if (tag === 'img') return '';
      if (tag === 'hr') return '\n\n---\n\n';

      // 标题独立成段
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const text = childrenMarkdown(node).trim();

        return text
          ? '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n'
          : '';
      }

      // 代码块
      if (tag === 'pre') {
        const code = node.innerText || node.textContent || '';

        return '\n\n```\n' + code.trimEnd() + '\n```\n\n';
      }

      // 引用块
      if (tag === 'blockquote') {
        const text = childrenMarkdown(node).trim();

        if (!text) return '';

        return '\n\n' + text
          .split('\n')
          .map(line => line ? '> ' + line : '>')
          .join('\n') + '\n\n';
      }

      // 列表：每个 li 独立一行，以两个空格和 - 开始
      if (tag === 'ul' || tag === 'ol') {
        const items = [...node.children].filter(
          child => child.tagName.toLowerCase() === 'li'
        );

        if (!items.length) return '';

        const lines = items.map(li => {
          // 获取列表项内容，避免重复生成 li 前缀
          const text = childrenMarkdown(li).trim();

          // 多行内容整理为单行，避免段落标签导致列表断行
          const singleLine = text
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .join(' ');

          return singleLine ? '  - ' + singleLine : '';
        }).filter(Boolean);

        return lines.length
          ? '\n\n' + lines.join('\n') + '\n\n'
          : '';
      }

      // li 由父级 ul/ol 统一处理
      if (tag === 'li') {
        return childrenMarkdown(node);
      }

      // 段落及常见块级容器
      if (['p', 'div', 'section', 'article'].includes(tag)) {
        const text = childrenMarkdown(node).trim();

        return text ? '\n\n' + text + '\n\n' : '';
      }

      return inlineMarkdown(node);
    }

    function childrenMarkdown(node) {
      return [...node.childNodes]
        .map(child => {
          if (child.nodeType === Node.ELEMENT_NODE) {
            return blockMarkdown(child);
          }
          return inlineMarkdown(child);
        })
        .join('');
    }

    function normalizeMarkdown(text) {
      return text
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n?/g, '\n')
      // 清除每一行末尾的空格
        .replace(/[ \t]+\n/g, '\n')
      // 清除普通文本行开头的空格，但保留列表缩进
        .replace(/^(?!  - )[ \t]+/gm, '')
      // 连续空行最多保留一行
        .replace(/\n{3,}/g, '\n\n');
    }

    // ===== 找到每条收藏内容的正文 =====

    function getArticleBody(card) {
      return card.querySelector('div.RichContent');
    }

    function getArticleTitle(card) {
      return card.querySelector('.ContentItem-title a')
      ?.innerText.trim()
        || card.querySelector('.ContentItem-title')
      ?.innerText.trim()
        || '未命名文章';
    }

    function getArticleUrl(card) {
      const link = card.querySelector('.ContentItem-title a');
      return link ? new URL(link.href, location.origin).href : '';
    }

    // ===== 处理当前页 =====

    async function processCurrentPage() {
      // 每处理完一篇重新查询 DOM，避免展开正文引起页面节点变化
      const cards = [...document.querySelectorAll(
        '.CollectionDetailPageItem'
      )];

      for (let i = 0; i < cards.length; i++) {
        if (stopped) return;

        const card = cards[i];
        const url = getArticleUrl(card);
        const title = getArticleTitle(card);

        if (!url || articles.has(url)) continue;

        console.log(
          `[文章 ${articles.size + 1}] 正在处理：${title}`
        );

        // 只在当前文章卡片内部查找“阅读全文”
        const moreButton = [...card.querySelectorAll('button')]
              .find(button =>
                button.innerText.trim().includes('阅读全文')
              );

        if (moreButton) {
          moreButton.click();
          await sleep(EXPAND_DELAY);
        }

        const body = getArticleBody(card);

        let content = '';

        if (body) {
          content = normalizeMarkdown(
            childrenMarkdown(body)
          );
        } else {
          console.warn('未找到正文容器：', title);
        }

        articles.set(url, {
          title,
          url,
          content
        });

        console.log(
          `已处理 ${articles.size} 篇，正文长度：${content.length}`
        );

        await sleep(ARTICLE_DELAY);
      }
    }

    // ===== 翻页 =====

    function currentPageNumber() {
      return document.querySelector(
        '.Pagination .PaginationButton--current'
      )?.innerText.trim() || '';
    }

    function getFirstArticleUrl() {
      return document.querySelector(
        '.CollectionDetailPageItem .ContentItem-title a'
      )?.href || '';
    }

    async function waitForPageChange(oldPage, oldFirstUrl) {
      for (let i = 0; i < 100; i++) {
        await sleep(200);

        const page = currentPageNumber();
        const firstUrl = getFirstArticleUrl();

        if (
          (page && page !== oldPage) ||
            (firstUrl && firstUrl !== oldFirstUrl)
        ) {
          await sleep(PAGE_DELAY);
          return true;
        }
      }

      return false;
    }

    // ===== 导出文件 =====

    function exportMarkdown() {
      const sections = [];

      for (const article of articles.values()) {
        sections.push(
          `# ${article.title}\n\n` +
            `原文链接：${article.url}\n\n` +
            (article.content || '> 未能自动提取正文，请检查原文。')
        );
      }

      const markdown =
            '# 知乎收藏夹导出\n\n' +
            sections.join('\n\n---\n\n') +
            '\n';

      const blob = new Blob(
        [markdown],
        { type: 'text/markdown;charset=utf-8' }
      );

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');

      a.href = objectUrl;
      a.download = 'zhihu-collection.md';
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);

      console.log(
        `导出完成：${articles.size} 篇文章，Markdown ${markdown.length} 字符`
      );
    }

    // ===== 主流程 =====

    try {
      while (!stopped) {
        const page = currentPageNumber();

        console.log(`开始处理第 ${page || '?'} 页`);

        await processCurrentPage();

        const nextButton = document.querySelector(
          '.Pagination button.PaginationButton-next'
        );

        // 没有下一页按钮，或者按钮不可用，视为最后一页
        if (!nextButton || nextButton.disabled) {
          console.log('已到最后一页。');
          break;
        }

        const oldPage = currentPageNumber();
        const oldFirstUrl = getFirstArticleUrl();

        nextButton.click();

        const changed = await waitForPageChange(
          oldPage,
          oldFirstUrl
        );

        if (!changed) {
          console.warn('翻页等待超时，停止继续采集。');
          break;
        }
      }

      exportMarkdown();

      alert(
        `导出结束，共收集 ${articles.size} 篇文章。\n` +
          '请检查下载的 Markdown 文件，确认正文完整。'
      );
    } catch (error) {
      console.error('导出过程出错：', error);
      alert('导出过程中发生错误，请打开控制台查看详情。');
    } finally {
      window.__zhihuCollectionExportRunning = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      createExportButton,
      { once: true }
    );
  } else {
    createExportButton();
  }
})();

// Local Variables:
// coding: utf-8
// tab-width: 2
// js-indent-level: 2
// End:
// vim: set fs=javascript fenc=utf-8 et ts=2 sts=2 sw=2
